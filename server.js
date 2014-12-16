///////////////
// VARIABLES //
///////////////

// essential modules
var http = require('http');
var qs = require('querystring');
var Datastore = require('nedb');
var fs = require('fs');

// delayed modules
var mdb;
var cheerio;
var request;
var Netcat;
var exec;
var socket;

// server
var host = process.argv[2]?process.argv[2].split(':'):['127.0.0.1','8374'];
var server_life = 60000;
var http_response;

// user prefs
var mdb_API_key = "26607a596b2ac49958a20ec3ab295259";
var percent_to_consider_watched = .85;
var magnet_expiration = 2; //hours
var no_magnet_recheck = 0.25;
var show_expiration = 96;
var season_expiration = 48;
var search_expiration = 168; //4 days
var keep_video_files_for = 48;
var video_quality = 200; // 200: all, 205: no HD, 208: only HD

// alfred
var w = new alfred_xml("florian.shows");
var node_pid = w.cache+"/node.pid";
var imgs_folder = w.data+"/imgs";
var episodes_folder = w.cache+"/episodes";
var summaries_folder = w.data+"/summaries";

// streaming
var peerflix_pid = w.cache+"/peerflix.pid";
var secondary_peerflix_pid = w.cache+"/next_ep_host.txt";
var is_streaming = false;
var delay_before_post_process = 120000;
var vlc_tcp = ['127.0.0.1','8376'];
var post_process_while_streaming, player_monitoring;
var stream_summary = {};

// globals
var db = {};
var timeout = setTimeout(exit_server, server_life);
var authorized_to_exit = false;
var delayed_images = [];
var delayed_images_interval;


//////////////
//  SERVER  //
//////////////

http.createServer(function (req, res) {
	if(timeout) clearTimeout(timeout);
	authorized_to_exit = false;
	if(post_process_while_streaming) clearTimeout(post_process_while_streaming);
	http_response = res;
	http_response.writeHead(200, {'Content-Type': 'text/plain'});

	if (req.method == 'POST') {
		var body = '';
		req.on('data', function (data) {
			body += data;
		});
		req.on('end', function () {
			var post = qs.parse(body);

			if(post['stream']){
				handle_stream(post['stream'], post['show_id'], post['player']);
				http_response.end('ok');
			}

			else if(post['fav']){
				toggle_fav(post['fav'], post['bool'], true);
				http_response.end('ok');
			}

			else if(post['mark_watched']){
				if(post['season'] && post['episode'])
					mark_as_watched(post['mark_watched'], post['season'], post['episode']);
				else
					mark_as_watched(post['mark_watched']);
				http_response.end('ok');
			}

			else if(post['magnet_id'])
				respond_with_magnet(post['magnet_id'], post['season'], post['episode'], http_response.end.bind(http_response));

			else if(post['next_magnet_id'])
				respond_with_next_magnet(post['next_magnet_id'], post['season'], post['episode'], http_response.end.bind(http_response));

			else
				use_query(post['query']);

		});
	} else {
		http_response.end('pong');
	}
	timeout = setTimeout(exit_server, server_life);
}).listen(host[1], host[0]);
initialize();

function initialize () {
	//things to do right away
	process.title = 'alfredTvShows';
	delayed_images_interval = setInterval(function () {
		for (var i = Math.min(5, delayed_images.length); i > 0; i--) {
			var img = delayed_images.shift();
			dl_image(imgs_folder+"/"+img.id, img.path);
		};
	}, 2000);
}

function finish_initializing () {
	//things that can wait a second (effectively: after sending out first response to alfred);
	if(!db.queries_history) db.queries_history = new Datastore({ filename: w.cache+"/queries_history.db", autoload: true });
	if(!db.shows) db.shows = new Datastore({ filename: w.data+"/shows.db", autoload: true });
	if(!cheerio) cheerio = require('cheerio');
	if(!mdb) mdb = require('moviedb')(mdb_API_key);
	if(!request) request = require('request');
	if(!exec) exec = require('child_process').exec;
	if(!fs.existsSync(summaries_folder)) fs.mkdirSync(summaries_folder);
	if(!fs.existsSync(imgs_folder)) fs.mkdirSync(imgs_folder);
	if(!fs.existsSync(episodes_folder)) fs.mkdirSync(episodes_folder);
}

function Parallel (){
	var all_fn = [];
	var open = true;
	this.add = function (parallelized) {
		all_fn.push(false);
		process.nextTick((function(index) {
			parallelized(callback.bind(this, index));
		}).bind(this, all_fn.length-1));
		return this;
	}
	this.done = function (fn) {
		done = fn;
		return this;
	}
	function done () {
		console.log("default done fn call");
	};
	function callback (index) {
		all_fn[index] = true;
		if(open && alldone()){
			open = false;
			done();
		}
	}
	function alldone () {
		for (var i = all_fn.length - 1; i >= 0; i--) {
			if(!all_fn[i]) return false;
		};
		return true;
	}
	return this;
}


///////////////////////
//  INTERFACE LOGIC  //
///////////////////////

function use_query (query) {
	console.log("\n=== new query: \""+query+"\" ===");
	w.zero();
	if(query) query = query.trimLeft().replace(/\s{2,}/g, " ").replace(/\($/g, "");
	if(query && query!="miscTopRatedTvs")
		search_for_show(query, out_to_alfred)
	else
		homepage(out_to_alfred)
}

function no_result(){
	var item = w.add("No result.");
	item.valid = "NO";
}

function out_to_alfred(){
	console.log("outputing xml");
	http_response.end(w.echo());
	finish_initializing();
}

function homepage(callback) {
	console.log("homepage");
	//echo favs with ordering: output + simple info
	if(!db.shows) db.shows = new Datastore({ filename: w.data+"/shows.db", autoload: true });
	var parallel = new Parallel().done(callback).add(function(done){
		if(is_streaming){
			db.shows.findOne({ id: parseInt(stream_summary.showId) }, function (err, doc) {
				var episode = doc.season[stream_summary.season].episode[stream_summary.episode];
				var item = w.add("▶ "+(stream_summary.logged_start?"Playing":"Loading")+" "+doc.name, 1);
				item.subtitle = (doc.fav?"♥ ":"")
				item.subtitle += (stream_summary.logged_start?"("+(stream_summary.duration?"":"at ")+pretty_seconds(stream_summary.progress)+(stream_summary.duration?" / "+pretty_seconds(stream_summary.duration):"")+") ":"");
				item.subtitle += formatted_episode_number(episode) + (pretty_string(episode.name)?" — "+episode.name:"");
				item.valid = "NO";
				parallel.add(function(done){
					db.shows.find({ name: stream_summary.showName }, (function (doc, item, err, docs) {
						item.autocomplete = doc.name+(docs.length>1 && doc.first_air_date ? " ("+doc.first_air_date.split("-")[0]+") " : " ");
						done();
					}).bind(undefined, doc, item));
				});
				parallel.add(function(done){
					fs.exists(imgs_folder+"/"+doc.id+".jpg", (function (item, name, exists) {
						item.icon = exists?name:"icon.png";
						done();
					}).bind(undefined, item, imgs_folder+"/"+doc.id+".jpg"));
				});
				done();
			})
			parallel.add(homepage2);
		} else {
			db.shows.find({ "last_watched": { $exists: true } }).sort({ "last_watched.timestamp": -1 }).limit(1).exec(function (err, docs) {
				if(docs && docs.length>0){
					find_ep_to_watch(docs[0], function (episode, show) {
						get_magnet(show, episode, (function (show, episode, magnet) {
							if(episode && magnet.piratebay){
								parallel.add(complete_oneline_output.bind(undefined, show, -5));
								parallel.add(homepage2.bind(undefined, show.id));
							} else {
								parallel.add(homepage2);
							}
							done();
						}).bind(undefined, show, episode));
					});
				} else {
					parallel.add(homepage2);
					done();
				}
			});
		}
	});

	function homepage2 (top_show_id, callback) {
		if(typeof top_show_id === 'function'){
			callback = top_show_id;
			top_show_id = undefined;
		}

		var parallel = new Parallel().done(callback).add(function(done){

			db.shows.find({ fav: true }).sort({ "last_watched.timestamp": 1 }).exec(function (err, fav_docs) {
				if(fav_docs){
					for (var l = fav_docs.length, i = l - 1; i >= 0; i--) {
						if((!is_streaming || stream_summary.showId != fav_docs[i].id) && top_show_id != fav_docs[i].id){
							parallel.add(complete_oneline_output.bind(undefined, fav_docs[i], l - i));
						}
					};
				}

				//echo misctv: simple output
				parallel.add(function(done){
					db.shows.find({ top: { $gt: 0 }}).sort({ "top": -1 }).exec(function(err, top_docs){
						if(top_docs && top_docs.length>0){
							for (var i = top_docs.length - 1; i >= 0; i--) {
								if(good_enough_show(top_docs[i]) && (!fav_docs || !is_doc_in_docs(top_docs[i].id, fav_docs)) && (!is_streaming || stream_summary.showId != top_docs[i].id) && top_docs[i].id != top_show_id){
									parallel.add(simple_output.bind(undefined, top_docs[i]));
								}
							};
							done();
						} else {
							search_on_mdb("miscTopRatedTvs", function (results) {
								for (var i = 0, l = results.length; i < l; i++) {
									if(good_enough_show(results[i]) && (!fav_docs || !is_doc_in_docs(results[i].id, fav_docs)) && (!is_streaming || stream_summary.showId != results[i].id) && results[i].id != top_show_id){
										parallel.add(simple_output.bind(undefined, results[i]));
									}
								}
								done();
							});
						}
					});
				})

				done();
			})
		});
	}
}

function search_for_show (query, callback) {
	console.log("search_for_show "+query);

	//sXXeXX browsing case
	var last_word = query.split(" ").pop();
	var corrected_query, season, episode;
	if((/(^s[0-9]{0,2}$)|(^s[0-9]{1,2}e[0-9]{0,2}$)/i).test(last_word)){
		corrected_query = query.substring(0, query.lastIndexOf(" "));
		console.log("corrected query: "+corrected_query);
		if(last_word.length>1){
			season = (/s[0-9]{1,2}e/i).test(last_word) ? last_word.match(/[0-9]+(?=e)/)[0] : last_word.match(/[0-9]+(?=$)/)[0]
			episode = (/s[0-9]{1,2}e[0-9]{1,2}/i).test(last_word) ? last_word.match(/[0-9]+(?=$)/)[0] : false;
		} else {
			season = episode = false
		}
	}

	query = corrected_query || query;

	var parallel = new Parallel().done(callback);

	// maybe we have that exact show in store already
	if(query.charAt(query.length-1)===" " && query.trim().length>0){
		if(!db.shows) db.shows = new Datastore({ filename: w.data+"/shows.db", autoload: true });
		var search = {};
		var year_match = query.trim().match(/ \(([0-9]{4})\)$/);
		if(year_match){
			console.log("with year precision");
			search.$and = [
				{ "name": { $regex: new RegExp("^"+query.trim().substring(0, year_match.index)+"$", "i") } },
				{ "first_air_date": { $regex: new RegExp("^"+year_match[1]) } }
			];
		} else {
			search.name = { $regex: new RegExp("^"+query.trim()+"$", "i")};
		}

		db.shows.find(search, function (err, docs) {
			if(docs.length == 1){
				doc = docs[0];
				doc.comes_from_db_already = true;
				if(!doc.timestamp || !doc.season || check_time_with(doc.timestamp, show_expiration) == -1){
					// notification because this might take some time
					console.log("notify");
					if(!exec) exec = require('child_process').exec;
					exec(("nohup /usr/bin/terminal-notifier -title \""+doc.name+"\" -message \"Fetching data, might take a sec...\" -contentImage \""+imgs_folder+"/"+doc.id+".jpg\" -sender com.runningwithcrayons.Alfred-2 >/dev/null 2>&1 &"), function(){});
				}
				if(corrected_query)
					parallel.add(browse.bind(undefined, doc, season, episode));
				else
					parallel.add(complete_output.bind(undefined, doc));
			} else {
				parallel.add(search_for_show2.bind(undefined, corrected_query, season, episode, query))
			}
		})
	} else {
		parallel.add(search_for_show2.bind(undefined, corrected_query, season, episode, query))
	}

	function search_for_show2(corrected_query, season, episode, query, callback){
		//search_on_mdb
		search_on_mdb (query, (function (corrected_query, season, episode, query, results) {

			if(!results || results.length==0){
				no_result();
				return callback();
			}

			// is query a match for a show (exact match or only one result)
			var only_one_good_show = false, good_shows_count = 0, exact_match = false, exact_match_count = 0;
			var temp_q = query.trim();
			for (var i = results.length - 1; i >= 0; i--) {
				if(good_enough_show(results[i])){
					if(temp_q==results[i].name){
						exact_match = results[i];
						exact_match_count++;
					}
					only_one_good_show = results[i];
					good_shows_count++;
				}
			};
			if(good_shows_count==0){
				no_result();
				return callback();
			}
			else if(good_shows_count>1 || (only_one_good_show && simplify_str(temp_q)!=simplify_str(only_one_good_show.name))) only_one_good_show = false;
			if(exact_match_count>1) exact_match = false;

			//single result: complete info
			if((only_one_good_show || exact_match ) && (query.charAt(query.length-1)===" ") || corrected_query){
				if(corrected_query)
					browse(only_one_good_show || exact_match, season, episode, callback);
				else
					complete_output(only_one_good_show || exact_match, callback);
			}

			//multiple results: simple output
			else {
				if(!db.shows) db.shows = new Datastore({ filename: w.data+"/shows.db", autoload: true });
				for (var i = 0, l = results.length; i < l; i++) {
					if(good_enough_show(results[i])){
						var appearsTwice = false;
						for (var j = results.length - 1; j >= 0; j--) {
							if(i!=j && simplify_str(results[j].name) == simplify_str(results[i].name)){
								appearsTwice = true;
								break;
							}
						};
						db.shows.findOne({ id: parseInt(results[i].id) }, (function (result, index, preciseDate, err, doc) {
							if(!doc || (!doc.last_watched && !doc.fav)){
								simple_output(result, preciseDate, callback);
							} else {
								complete_oneline_output(doc, index, preciseDate, callback);
							}
						}).bind(undefined, results[i], i, appearsTwice));
					}
				}
			}
		}).bind(undefined, corrected_query, season, episode, query))
	}
}

function simple_output(result, preciseDate, callback) {
	if (typeof preciseDate === 'function'){
		callback = preciseDate;
		preciseDate = undefined;
	}

	var parallel = new Parallel().done(callback).add(function(done){
		var item = w.add(result.name);
		item.valid = "NO";
		// item.subtitle = rating_in_stars(result.vote_average); // +" — "+result.name+(result.first_air_date?" ("+(result.first_air_date.split("-")[0])+")":"");
		if(preciseDate === undefined){
			parallel.add(function(done){
				db.shows.find({ name: result.name }, (function (result, err, docs) {
					item.autocomplete = result.name+(docs.length>1 && result.first_air_date ? " ("+result.first_air_date.split("-")[0]+") " : " ");
					done();
				}).bind(undefined, result));
			})
		} else {
			item.autocomplete = result.name+(preciseDate && result.first_air_date ? " ("+result.first_air_date.split("-")[0]+") " : " ");
		}
		fs.exists(imgs_folder+"/"+result.id+".jpg", (function (item, name, exists) {
			item.icon = exists?name:"icon.png";
			done();
		}).bind(undefined, item, imgs_folder+"/"+result.id+".jpg"));
	})
}

function complete_oneline_output (result, order_index, preciseDate, callback) {
	if (typeof order_index === 'function'){
		callback = order_index;
		order_index = undefined;
	} else if (typeof preciseDate === 'function'){
		callback = preciseDate;
		preciseDate = undefined;
	}

	//look for extra things to display
	find_ep_to_watch(result, (function (callback, doc, order_index, episode) {
		var subtitle = "";
		var order_range = 10;
		if(episode){
			if(episode.progress){
				subtitle += Math.round(100*episode.progress/episode.duration)+"% of "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" );
				callback(order_range+order_index, subtitle);
			} else if(doc.last_watched) {
				if(episode.air_date && check_time_with(date_from_tmdb_format(episode.air_date), 0) == 1){
					subtitle += "New episode "+pretty_date(episode.air_date)+": "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" );
					order_range = 300;
					callback(order_range+days_until(episode.air_date), subtitle);
				} else {
					get_magnet(doc, episode, (function (callback, doc, subtitle, episode, order_index, magnet) {
						var temp_sub = formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" );
						if(!magnet.piratebay){
							if (magnet.error){
								order_range = 180;
								temp_sub = "Up soon: "+temp_sub+" — The torrent database couldn't be reached, please try again later...";
							} else if(episode.air_date && check_time_with(date_from_tmdb_format(episode.air_date), 24) == 1){
								order_range = 150;
								temp_sub = "Airing today: "+temp_sub;
							} else if(episode.air_date && check_time_with(date_from_tmdb_format(episode.air_date), 48) == 1){
								order_range = 100;
								temp_sub = "Up soon: "+temp_sub+" — This episode aired yesterday, wait a little for the torrent...";
							} else {
								order_range = 180;
								temp_sub += " — Torrent unavailable on piratebay.";
							}
						} else {
							var new_ep_flag = false;
							if(doc.last_watched && doc.season && doc.season[""+episode.season_number+""]) {
								var latest_season = find_latest(doc.season);
								if( latest_season.season_number == episode.season_number && doc.season[""+episode.season_number+""].episode && doc.season[""+episode.season_number+""].episode[""+episode.episode_number+""] ){
									var latest_episode = find_latest(doc.season[""+episode.season_number+""].episode);
									if(latest_episode.episode_number == episode.episode_number && doc.last_watched.timestamp < date_from_tmdb_format(episode.air_date)){
										new_ep_flag = true;
									}
								}
							}
							temp_sub = (new_ep_flag?"NEW EPISODE: ":"Up next: ")+temp_sub;
						}
						subtitle += temp_sub;
						callback(order_range + order_index, subtitle);
					}).bind(undefined, callback, doc, subtitle, episode, order_index))
				}
			} else if(doc.status && (doc.status==="Ended" || doc.status==="Canceled")) {
				subtitle += "Last episode (show has ended): "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" );
				order_range = 200
				callback(order_range+order_index, subtitle);
			} else {
				subtitle += "Latest episode: "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" );
				order_range = 200;
				callback(order_range+order_index, subtitle);
			}
		} else {
			find_next_release(doc, (function (callback, doc, order_index, episode) {
				if(episode){
					var first = ( episode.season_number == 1 && episode.episode_number == 1 ? "First" : "Next" );
					var date = episode.air_date?pretty_date(episode.air_date):false;
					order_range = 300;
					if(date) subtitle += first+" episode "+date
				} else if(doc.status && doc.status=="Ended") {
					subtitle += "Ended & watched";
					order_range = 1000
				} else {
					subtitle += "Next episode's date not set yet";
					order_range = 700;
				}
				callback(order_range+order_index, subtitle);
			}).bind(undefined, callback, doc, order_index));
		}
	}).bind(undefined, (function (callback, result, preciseDate, order_range, subtitle) {
		var parallel = new Parallel().done(callback).add(function (done) {
			//add result
			var item = w.add(result.name, order_range);
			if(result.fav) subtitle = "♥ "+subtitle;
			item.subtitle = subtitle;
			item.valid = "NO";
			item.uid = "result.name";
			if(preciseDate === undefined){
				parallel.add(function (done) {
					db.shows.find({ name: result.name }, (function (result, err, docs) {
						item.autocomplete = result.name+(docs.length>1 && result.first_air_date ? " ("+result.first_air_date.split("-")[0]+") " : " ");
						done();
					}).bind(undefined, result));
				})
			} else {
				item.autocomplete = result.name+(preciseDate && result.first_air_date ? " ("+result.first_air_date.split("-")[0]+") " : " ");
			}
			parallel.add(function (done) {
				fs.exists(imgs_folder+"/"+result.id+".jpg", (function (item, name, exists) {
					item.icon = exists?name:"icon.png";
					done();
				}).bind(undefined, item, imgs_folder+"/"+result.id+".jpg"));
			})
			done();
		})
	}).bind(undefined, callback, result, preciseDate), result, order_index))
}

function browse (result, season, episode, callback) {
	console.log("browse");
	if(season) season = parseInt(season);
	if(episode) episode = parseInt(episode);
	if(!db.shows) db.shows = new Datastore({ filename: w.data+"/shows.db", autoload: true });

	if(result.comes_from_db_already)
		browse2(result, season, episode, callback)
	else{
		db.shows.findOne({ id: result.id }, (function (result, season, episode, err, doc) {
			if(doc){
				browse2(doc, season, episode, callback)
			} else {
				detail_show(result, (function (season, episode, doc) {
					browse2(doc, season, episode, callback)
				}).bind(undefined, season, episode));
			}
		}).bind(undefined, result, season, episode));
	}

	function browse2 (doc, season_number, episode_number, callback) {
		season_number = parseInt(season_number)
		episode_number = parseInt(episode_number)
		if(episode_number){
			get_specific_episode(doc, season_number, episode_number, function (episode, show) {
				if(episode.episode_number && episode.episode_number != 0){
					get_magnet(show, episode, (function (episode, show, magnet) {
						if(magnet.piratebay){
							episode.magnet = magnet;
						}
						var item = w.add(( episode.name && pretty_string(episode.name) ) ? episode.name : show.name+" "+formatted_episode_number(episode));
						if(episode.air_date && date_from_tmdb_format(episode.air_date)>Date.now())
							item.subtitle = "Will air "+pretty_date(episode.air_date)+"."
						else if(episode.magnet && episode.magnet.piratebay){
							if(episode.progress && percent_progress(episode)<percent_to_consider_watched*100){
								item.subtitle = "Resume watching at "+percent_progress(episode)+"% ( ⌘+Enter to watch from the beginning, ⌥+Enter to download torrent )"+", seeds: "+episode.magnet.piratebay.seeders;
								item.cmd = "Watch from the beginning ( release ⌘ to resume streaming at "+percent_progress(episode)+"%, ⌥+Enter to download torrent )"+", seeds: "+episode.magnet.piratebay.seeders;
								item.arg = "m"+show.id+" "+episode.season_number+" "+episode.episode_number+" "+(episode.progress || 0)+" "+show.name+", "+formatted_episode_number(episode)+": "+episode.name;
							} else {
								item.subtitle = "Start streaming this episode ( ⌥+Enter to download torrent )"+", seeds: "+episode.magnet.piratebay.seeders;
								item.arg = "m"+show.id+" "+episode.season_number+" "+episode.episode_number+" 0 "+show.name+", "+formatted_episode_number(episode)+": "+episode.name;
							}
							item.alt = "Download torrent ( release ⌥ to "+(episode.progress && episode.progress>30?"resume streaming at "+percent_progress(episode)+"%, ⌘+Enter to watch from the beginning":"start streaming this episode")+" )";
						} else {
							if(magnet.error)
								item.subtitle = "The torrent database couldn't be reached, please try again later...";
							else if(episode.air_date && date_from_tmdb_format(episode.air_date) > Date.now()-25*60*60*1000)
								item.subtitle = "This episode is airing today, wait a little for the torrent...";
							else if(episode.progress && percent_progress(episode)<percent_to_consider_watched*100)
								item.subtitle = "You watched "+percent_progress(episode)+"% of this episode, but it isn't available on piratebay anymore. Press Enter to mark as watched."
							else
								item.subtitle = "Not available on piratebay";
							item.valid = "NO";
						}
						callback();
					}).bind(undefined, episode, show))
				} else{
					no_result();
					return callback();
				}
			});
		} else if(season_number && season_number != 0){
			get_episodes(doc, season_number, (function (season_number, show) {
				if(show.season[""+season_number+""] && show.season[""+season_number+""].episode){
					var keys = Object.keys(show.season[""+season_number+""].episode).sort(function (a, b) {
						a=parseInt(a);
						b=parseInt(b);
						return (a>b?-1:a<b?1:0);
					})
					if(keys.length>0){
						for (var i = 0, l = keys.length; i < l; i++) {
							if(parseInt(keys[i])!=0){
								var episode = show.season[""+season_number+""].episode[""+keys[i]+""];
								var item = w.add(episode.episode_number+" - "+(pretty_string(episode.name) ? episode.name : "Episode "+episode.episode_number), i+1);
								item.autocomplete = show.name + " s" + leading_zero(season_number) + "e" + leading_zero(show.season[""+season_number+""].episode[""+keys[i]+""].episode_number);
								item.valid = "NO";
								if(show.last_watched && show.last_watched.season == season_number && show.last_watched.episode == episode.episode_number){
									item.subtitle = "This is the last episode you watched."+(show.last_watched.progress && show.last_watched.duration ? " You stopped at "+percent_progress(episode)+"%." : "");
								} else if(episode.air_date && check_time_with(date_from_tmdb_format(episode.air_date), 0) == 1){
									item.subtitle = "Will air "+pretty_date(episode.air_date)+".";
								}
							}
						};
						get_magnets_for_season(show, season_number, function () {});
					} else {
						var item = w.add((show.season[""+season_number+""].name || ("Season "+season_number)) + ": no episode.");
						item.subtitle = "themoviedb.org has no entry for this season. You can head to their site and rectify this ;-)"
					}
				} else {
					no_result();
					return callback();
				}
				callback();
			}).bind(undefined, season_number));
		} else {
			get_seasons(doc, function (show) {
				var keys = Object.keys(show.season).sort(function (a, b) {
					a=parseInt(a);
					b=parseInt(b);
					return (a>b?-1:a<b?1:0);
				})
				for (var i = 0, l = keys.length; i < l; i++) {
					if(parseInt(keys[i])!=0){
						var std_name = "Season "+show.season[""+keys[i]+""].season_number;
						var name = show.season[""+keys[i]+""].name || false;
						var item = w.add(!name || simplify_str(name)==simplify_str(std_name) ? std_name : std_name+": "+name, i+1);
						item.valid = "NO";
						item.autocomplete = show.name + " s" + leading_zero(show.season[""+keys[i]+""].season_number);
						if(show.last_watched && show.last_watched.season == show.season[""+keys[i]+""].season_number ){
							item.subtitle = "You last watched the "+st_nd_rd_th(show.last_watched.episode)+" episode of this season.";
						}
					}
				};
				callback();
			});
		}
	}
}

function complete_output (result, callback) {
	console.log("complete_output "+result.name);
	if(result.comes_from_db_already)
		complete_output_2(result, callback)
	else{
		if(!db.shows) db.shows = new Datastore({ filename: w.data+"/shows.db", autoload: true });
		db.shows.findOne({ id: result.id }, (function (result, err, doc) {
			if(doc){
				complete_output_2(doc, callback)
			} else {
				detail_show(result, function (doc) {
					complete_output_2 (doc, callback)
				});
			}
		}).bind(undefined, result));
	}

	function complete_output_2 (doc, callback){
		//
		if(doc && doc.id){
			anonymous_shows+=(anonymous_shows.length==0?"":" ")+doc.id+"";
		}
		//what to watch
		var parallel = new Parallel().done(callback).add(function (done) {
			find_ep_to_watch(doc, function (episode, doc) {
				var item = w.add("", 1)
				if(is_streaming && stream_summary.showId == doc.id){
					episode = doc.season[""+parseInt(stream_summary.season)+""].episode[""+parseInt(stream_summary.episode)+""];
					item.title = (stream_summary.logged_start?"Playing":"Loading")+" "+doc.name+" "+formatted_episode_number(episode)+(pretty_string(episode.name)?" — "+episode.name:"");
					item.arg = "c"+doc.id+" "+stream_summary.season+" "+stream_summary.episode+" "+doc.name;
					item.subtitle = "▶ ";
					if(stream_summary.logged_start) item.subtitle += (stream_summary.duration?"":"at ")+pretty_seconds(stream_summary.progress)+(stream_summary.duration?" / "+pretty_seconds(stream_summary.duration):"")+", ";
					item.alt = item.subtitle;
					item.cmd = item.subtitle;
					if(stream_summary.logged_start){
						item.subtitle += "Stop streaming ( ⌘+Enter to mark as watched, ⌥+Enter to download instead of streaming )";
						item.alt += 	 "Stop and download torrent ( ⌘+Enter to mark as watched, release ⌥ to just stop streaming )"
						item.cmd += 	 "Stop and mark as watched ( release ⌘ to just stop streaming, ⌥+Enter to download instead )"
					} else {
						item.subtitle += "Abort streaming ( ⌘+Enter to mark as watched, ⌥+Enter to download instead of streaming )";
						item.alt += 	 "Abort and download torrent ( ⌘+Enter to mark as watched, release ⌥ to just abort streaming )"
						item.cmd += 	 "Abort and mark as watched ( release ⌘ to just abort streaming, ⌥+Enter to download instead )"
					}
				} else {
					if(episode){
						//get magnet
						parallel.add((function (item, done) {
							get_magnet(doc, episode, (function (item, episode, doc, magnet) {
								if(episode.progress && episode.progress>30){
									if(magnet.piratebay){
										item.title = "Resume watching "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" )
										item.subtitle = "You stopped at "+percent_progress(episode)+"% ( ⌘+Enter to watch from the beginning, ⌥+Enter to download torrent )"+", seeds: "+magnet.piratebay.seeders;
										item.cmd = "Watch from the beginning ( release ⌘ to resume streaming at "+percent_progress(episode)+"%, ⌥+Enter to download torrent )"+", seeds: "+magnet.piratebay.seeders;
									}
									else{
										item.title = "You stopped at "+percent_progress(episode)+"% of "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" )
										item.subtitle = "but this episode isn't available on piratebay anymore. Press Enter to mark as watched."
										item.arg = "ws"+doc.id+" "+episode.season_number+" "+episode.episode_number+" "+doc.name;
									}
								} else {
									item.title = formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" );
									if(doc.last_watched)
										item.title = "Up next: "+item.title;
									else
										item.title = "Latest episode: "+item.title;
									if(magnet && magnet.piratebay){
										item.subtitle = "Start streaming this episode ( ⌥+Enter to download torrent )"+", seeds: "+magnet.piratebay.seeders;
									} else {
										if(episode.air_date && check_time_with(date_from_tmdb_format(episode.air_date), 0) == 1)
											item.subtitle = "Will air "+pretty_date(episode.air_date)+".";
										else if(episode.air_date && check_time_with(date_from_tmdb_format(episode.air_date), 25) == 1) // TODO this case is true even when the episode is totally not out soon
											item.subtitle = "This episode is airing today, wait a little for the torrent...";
										else
											item.subtitle = "Not available on piratebay";
										item.valid="NO";
									}
								}
								if(magnet.piratebay){
									item.arg = "m"+doc.id+" "+episode.season_number+" "+episode.episode_number+" "+(episode.progress || 0)+" "+doc.name+", "+formatted_episode_number(episode)+": "+episode.name
									item.alt = "Download torrent ( release ⌥ to "+(episode.progress && episode.progress>30?"resume streaming at "+percent_progress(episode)+"%, ⌘+Enter to watch from the beginning":"start streaming this episode")+" )";
								}
								done();
							}).bind(undefined, item, episode, doc))
						}).bind(undefined, item));
					} else {
						console.log("found nothing to watch for "+doc.name);
						item.valid="NO";
						if(doc.status == "Ended"){
							item.title = "You have finished this show. Congratulation ;-)";
							item.subtitle = "Press Enter to browse past episodes";
							item.autocomplete = doc.name+" s";
						}
						else{
							item.title = "You are up to date with this show";
							item.subtitle = "Following episode has yet to be revealed";
						}
					}
				}


				//next out
				if(episode){
					parallel.add(function (done) {
						get_episode_after_episode(doc, episode, function (next_episode, doc) {
							var item = w.add("", 2);
							if(next_episode) {
								get_magnet(doc, next_episode, (function (item, episode, doc, magnet) {
									item.title = "Following episode: "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" );
									if(magnet && magnet.piratebay){
										item.subtitle = "Start streaming this episode ( ⌥+Enter to download torrent )"+", seeds: "+magnet.piratebay.seeders;
										item.arg = "m"+doc.id+" "+episode.season_number+" "+episode.episode_number+" 0 "+doc.name+", "+formatted_episode_number(episode)+": "+episode.name
										item.alt = "Download torrent ( release ⌥ to start streaming this episode )"+", seeds: "+magnet.piratebay.seeders;
										if(is_streaming && stream_summary.showId == doc.id){
											item.alt = "▶▍"+item.alt;
											item.subtitle = "▶▍"+item.subtitle;
										}
									} else {
										if(episode.air_date && check_time_with(date_from_tmdb_format(episode.air_date), 0) == 1)
											item.subtitle = "Will air "+pretty_date(episode.air_date)+".";
										else if(episode.air_date && check_time_with(date_from_tmdb_format(episode.air_date), 25) == 1) // TODO this case is true even when the episode is totally not out soon
											item.subtitle = "This episode is airing today, wait a little for the torrent...";
										else
											item.subtitle = "Not available on piratebay";
										item.valid="NO";
									}
									done();
								}).bind(undefined, item, next_episode, doc))
							} else {
								item.title = "---";
								item.valid="NO";
								if(doc.status != "Ended")
									item.subtitle = "Following episode has yet to be revealed";
								else
									item.subtitle = "This show has ended :-(";
								done();
							}
						})
					})
				}

				//description
				var rating = Math.round(doc.vote_average/2)
				var stars = rating_in_stars(doc.vote_average)
				var year = doc.first_air_date.split("-")[0];
				var genres = "";
				for (var i = 0, l = doc.genres.length; i < l; i++) {
					genres += (i>0?", ":"")+doc.genres[i].name;
				};
				make_preview_page(doc.id, doc.name, genres, rating, doc.status, year, doc.overview);
				var item = w.add(doc.overview, 3);
				item.subtitle = stars+" ("+year+") "+genres+" — "+doc.status;
				item.arg = "l"+doc.id+" "+doc.name
				item.largetype = doc.overview;
				item.icon = "what.png";

				//favorite toggle
				var item = w.add("", 4)
				if(doc.fav==true){
					item.title = "Remove "+doc.name+" from my favorites";
					item.arg = "f0"+doc.id+" "+doc.name;
				}
				else{
					item.title = "Add "+doc.name+" to my favorites";
					item.arg = "f1"+doc.id+" "+doc.name;
				}
				item.subtitle = "Favorited TV Shows appear on the main screen with nifty results :-)"
				item.icon = "love.png";

				//watch specific episode
				var item = w.add("Browse all episodes", 5)
				item.subtitle = "Allows you to set where you're at in this show"
				item.valid = "NO"
				item.autocomplete = doc.name+" s"

				//mark as watched
				parallel.add(function (done) {
					find_latest_episode_of_show(doc, function (episode, doc) {
						if(!doc.last_watched || !(doc.last_watched.season == episode.season_number && doc.last_watched.episode == episode.episode_number && (!doc.last_watched.progress || doc.last_watched.progress/doc.last_watched.duration>percent_to_consider_watched))){
							var item = w.add("Mark this show as watched", 6)
							item.subtitle = "This way you'll get a better display of what's up next for you"
							item.arg = "wf"+doc.id+" "+doc.name;
						}
						done();
					})
				})

				done();
			});
		});
	}
}


///////////////////////
//  INTERFACE UTILS  //
///////////////////////

function pretty_seconds (seconds){
	if(seconds<=3600) return leading_zero(Math.floor(seconds/60))+":"+leading_zero(Math.floor(seconds%60));
	else return leading_zero(Math.floor(seconds/3600))+":"+leading_zero(Math.floor((seconds%3600)/60))+":"+leading_zero(Math.floor((seconds%3600)%60));
}

function good_enough_show (show) {
	return (show.name && (!show.first_air_date || show.first_air_date.split("-")[0]>1985) && show.popularity>0.001 && show.poster_path);
}

function pretty_string (str) {
	return str.replace(/[^a-zA-Z]/g, '').length>3;
}

function simplify_str (str) {
	return str.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function leading_zero (str) {
	return (""+str+"").length==1?"0"+str:str;
}

function formatted_episode_number(episode){
	return "s"+leading_zero(episode.season_number)+"e"+leading_zero(episode.episode_number);
}

function rating_in_stars(rating){
	var stars = "", nb_of_stars = Math.round(rating/2);
	for (var i = 1; i < 6; i++) { stars+=i>nb_of_stars?"☆":"★" };
	return stars;
}

function percent_progress(episode){
	return Math.round(100*episode.progress/episode.duration);
}

function is_doc_in_docs (id, docs) {
	for (var i = docs.length - 1; i >= 0; i--) {
		if(docs[i].id == id) return true;
	};
	return false;
}

function st_nd_rd_th (nb) {
	switch ((""+nb+"").slice(-1)){
		case "1": return ""+nb+"st"; break
		case "2": return ""+nb+"nd"; break
		case "3": return ""+nb+"rd"; break
		default: return ""+nb+"th";
	}
}

function check_time_with (timestamp, timeref_in_hours){
	if(!timestamp || timeref_in_hours===undefined || timeref_in_hours===null) return false;
	return (timestamp < (Date.now() - timeref_in_hours*60*60*1000)) ? -1 : (timestamp > (Date.now() - timeref_in_hours*60*60*1000)) ? 1 : 0;
}

function make_preview_page (id, showName, genres, rating, status, year, text){
	//create content
	fs.readFile("template.txt", 'utf8', function (err, data) {
		data = data.replace(/{showName}/, showName);
		data = data.replace(/{year}/, year);
		data = data.replace(/{genres}/, genres);
		data = data.replace(/{status}/, status);
		text = text.replace(/\n/, "\\\n\\");
		data = data.replace(/{text}/, text);

		data = data.replace(/{star1}/, (rating>=1?"ef":"ee"));
		data = data.replace(/{star2}/, (rating>=2?"ef":"ee"));
		data = data.replace(/{star3}/, (rating>=3?"ef":"ee"));
		data = data.replace(/{star4}/, (rating>=4?"ef":"ee"));
		data = data.replace(/{star5}/, (rating>=5?"ef":"ee"));

		//write file
		fs.writeFile(summaries_folder+"/"+id+".rtf", data, function(err) {

		});
	});

}

function days_until(date) {
	if(!date) return false;
	date = date_from_tmdb_format(date);
	var days = (date - Date.now())/(1000*60*60*24);
	return Math.floor(days)+(days<0?1:0);
}

function pretty_date (date) {

	var next_air_date = date.split("-");
	next_air_date = new Date(next_air_date[0], next_air_date[1]-1, next_air_date[2]);
	var now = new Date(Date.now());
	var diff = next_air_date.getTime()-now.getTime();
	var next_ep_str = "";

	if(diff < 0){
		return false;
	} else if(diff > 4*7*24*60*60*1000){ // more than 4 weeks => "in January 2099"
		next_ep_str = "in "+(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][next_air_date.getMonth()])
		if((now.getFullYear()+1==next_air_date.getFullYear() && now.getMonth()<=next_air_date.getMonth()) || now.getFullYear()+1<next_air_date.getFullYear()){
			next_ep_str += " "+next_air_date.getFullYear();
		}
	} else if(diff > 2*7*24*60*60*1000){ // more than 2 weeks => "in 3 weeks"
		next_ep_str = "in " + Math.floor(diff / (7*24*60*60*1000)) + " weeks";
	} else if(diff > 7*24*60*60*1000){ // more than a week => "in 10 days" or "next week on Tuesday" if appropriate
		if((next_air_date.getDay()+1)%7>=(now.getDay()+1)%7)
			next_ep_str = "next week on "+(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][next_air_date.getDay()]);
		else
			next_ep_str = "in " + Math.floor(diff / (24*60*60*1000)) + " days";
	} else if(now.getDate()==next_air_date.getDate()){ // same day => "today"
		next_ep_str = "today";
	} else {
		var tomorrow = new Date(Date.now());
		tomorrow.setDate(tomorrow.getDate() + 1);
		if(tomorrow.getFullYear()==next_air_date.getFullYear() && tomorrow.getMonth()==next_air_date.getMonth() && tomorrow.getDate()==next_air_date.getDate()){
			next_ep_str = "tomorrow"
		} else {
			next_ep_str = next_air_date.getDay()==now.getDay() ? "next" : "on";
			next_ep_str += " "+(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][next_air_date.getDay()]);
		}
	}
	return next_ep_str;
}


////////////////////////////////////////
//  LOCAL AND MOVIE DATABASE RELATED  //
////////////////////////////////////////

function find_latest(array) {
    var latest;
    // var now = Date.now();
    for (var i = (array.isArray ? array.length : Object.keys(array).length) - 1; i >= 0; i--) {
        var index = array.isArray ? i : Object.keys(array)[i]
        //avoid season/episode 0 (usually "specials") being the main thing
        if (array[index].season_number == 0 || array[index].episode_number == 0) continue;
        //initialize with any
        if (!latest) {
            if (array[index].air_date && check_time_with(date_from_tmdb_format(array[index].air_date), 0) == -1) latest = array[index];
            continue;
        }
        //if "air_date" is defined for array[index] and is greater than that of latest (or latest's is undefined) but still smaller than Date.now()
        if (array[index].air_date && (!latest.air_date || array[index].air_date.localeCompare(latest.air_date) > 0) && check_time_with(date_from_tmdb_format(array[index].air_date), 0) == -1) latest = array[index];
    };
    return (latest && latest.air_date) ? latest : false;
}

function date_from_tmdb_format(tmdb_date) {
    var temp_date = tmdb_date.split("-");
    return new Date(temp_date[0], temp_date[1] - 1, temp_date[2])
}

function find_next_release (show, callback) {
	if(show.status == "Ended"){
		callback(false, show)
	} else {
	    get_seasons(show, (function(callback, show) {
	        if (!show.season) callback(false, show)
	        else {
	            var latest_season = find_latest(show.season)
	            if (!latest_season) callback(false, show)
	            else {
	                get_episodes(show, latest_season.season_number, (function(callback, season_number, show) {
	                    if (!show.season[season_number].episode) callback(false, show);
	                    else{
	                        var latest_ep = find_latest(show.season[season_number].episode);
	                        if(show.season[season_number].episode[latest_ep.episode_number+1]){
	                            callback(show.season[season_number].episode[latest_ep.episode_number+1], show)
	                        } else if(show.season[season_number+1]) {
	                            get_episodes(show, season_number+1, (function(callback, season_number, show) {
	                                if(show.season[season_number].episode && show.season[season_number].episode[1]) callback(show.season[season_number].episode[1], show)
	                                else callback(false, show);
	                            }).bind(undefined, callback, season_number+1))
	                        } else {
	                            callback(false, show);
	                        }
	                    }
	                }).bind(undefined, callback, latest_season.season_number))
	            }
	        }
	    }).bind(undefined, callback))
	}
}

function find_latest_episode_of_show(show, callback){
	get_seasons(show, (function(callback, show) {
	    if (!show.season) callback(false, show)
	    else {
	        var latest_season = find_latest(show.season)
	        if (!latest_season) callback(false, show)
	        else {
	            get_episodes(show, latest_season.season_number, (function(callback, latest_season, show) {
	                if (!show.season[latest_season.season_number].episode) callback(false, show);
	                else callback(find_latest(show.season[latest_season.season_number].episode), show)
	            }).bind(undefined, callback, latest_season))
	        }
	    }
	}).bind(undefined, callback))
}

function find_ep_to_watch(show, callback) {
    if (show.last_watched) {
        if (show.last_watched.progress && show.last_watched.duration && show.last_watched.progress / show.last_watched.duration < percent_to_consider_watched) get_specific_episode(show, show.last_watched.season, show.last_watched.episode, callback)
        else get_specific_episode(show, show.last_watched.season, parseInt(show.last_watched.episode) + 1, (function(callback, episode, show) {
            if (episode) callback(episode, show)
            else get_specific_episode(show, parseInt(show.last_watched.season) + 1, 1, callback)
        }).bind(undefined, callback))
    } else {
    	console.log(show.name+" has no last watched")
        find_latest_episode_of_show(show, callback);
    }
}

function get_episode_after_episode(show, prev_episode, callback) {
	get_specific_episode(show, prev_episode.season_number, prev_episode.episode_number + 1, (function(callback, prev_episode, next_episode, show) {
		if (next_episode) callback(next_episode, show)
		else get_specific_episode(show, prev_episode.season_number + 1, 1, callback)
	}).bind(undefined, callback, prev_episode))
}

function get_specific_season(show, season_number, callback) {
	if(season_number){
	    // everything taken care of for getting this season
	    if (show && show.season && show.season[season_number]) callback(show.season[season_number], show)
	    else get_seasons(show, (function(callback, season_number, show) {
	        if (show && show.season && show.season[season_number]) callback(show.season[season_number], show)
	        else callback(false)
	    }).bind(undefined, callback, season_number))
	} else callback(false)
}

function get_seasons(show, callback) {
    // should i go fetch new data for the show?
    if (!show.season ||  check_time_with(show.timestamp, show_expiration) == -1) detail_show(show, callback)
    else callback(show);
}

function detail_show(doc, callback) {
	console.log("detail_show ----------- > internet connection (mdb)");
    // fetch new data for the show
    if(!mdb) mdb = require('moviedb')(mdb_API_key);
    mdb.tvInfo({
        id: doc.id
    }, (function(callback, doc, err, res) {
    	if(err) console.log(err);
        doc = update_doc_with_tvInfo(doc, res);
        callback(doc);
    }).bind(undefined, callback, doc))
}

function update_doc_with_seasonInfo(doc, res, season_number) {

	if(res && season_number){

	    // updates doc with new data for the show
	    doc["season"]["" + season_number + ""]["timestamp"] = Date.now();
	    doc["season"]["" + season_number + ""]["name"] = res.name;
	    doc["season"]["" + season_number + ""]["overview"] = res.overview;
	    doc["season"]["" + season_number + ""]["air_date"] = res.air_date;
	    if (!doc["season"]["" + season_number + ""]["episode"]) doc["season"]["" + season_number + ""]["episode"] = {};
	    for (var i = 0, l = res.episodes.length; i < l; i++) {
	    	if(res.episodes[i].episode_number!=0){
		        if (!doc["season"]["" + season_number + ""]["episode"]["" + res.episodes[i].episode_number + ""]) doc["season"]["" + season_number + ""]["episode"]["" + res.episodes[i].episode_number + ""] = {};
		        doc["season"]["" + season_number + ""]["episode"]["" + res.episodes[i].episode_number + ""]["episode_number"] = res.episodes[i].episode_number;
		        doc["season"]["" + season_number + ""]["episode"]["" + res.episodes[i].episode_number + ""]["season_number"] = season_number;
		        doc["season"]["" + season_number + ""]["episode"]["" + res.episodes[i].episode_number + ""]["air_date"] = res.episodes[i].air_date;
		        doc["season"]["" + season_number + ""]["episode"]["" + res.episodes[i].episode_number + ""]["name"] = res.episodes[i].name;
		        doc["season"]["" + season_number + ""]["episode"]["" + res.episodes[i].episode_number + ""]["overview"] = res.episodes[i].overview;
		        doc["season"]["" + season_number + ""]["episode"]["" + res.episodes[i].episode_number + ""]["still_path"] = res.episodes[i].still_path;
		    }
	    };

	    // update database with new data for the show
	    var setModifier = { $set: {} };
	    setModifier.$set["season."+season_number+".timestamp"] = Date.now();
	    setModifier.$set["season."+season_number+".name"] = res.name;
	    setModifier.$set["season."+season_number+".overview"] = res.overview;
	    setModifier.$set["season."+season_number+".air_date"] = res.air_date;
	    for (var i = 0, l = res.episodes.length; i < l; i++) {
	    	if(res.episodes[i].episode_number && res.episodes[i].episode_number!=0){
		    	setModifier.$set["season."+season_number+".episode."+res.episodes[i].episode_number+".episode_number"] = res.episodes[i].episode_number;
		    	setModifier.$set["season."+season_number+".episode."+res.episodes[i].episode_number+".season_number"] = season_number;
		    	setModifier.$set["season."+season_number+".episode."+res.episodes[i].episode_number+".air_date"] = res.episodes[i].air_date;
		    	setModifier.$set["season."+season_number+".episode."+res.episodes[i].episode_number+".name"] = res.episodes[i].name;
		    	setModifier.$set["season."+season_number+".episode."+res.episodes[i].episode_number+".overview"] = res.episodes[i].overview;
		    	setModifier.$set["season."+season_number+".episode."+res.episodes[i].episode_number+".still_path"] = res.episodes[i].still_path;
		    }
	    }
	    db.shows.update({
	        id: parseInt(doc.id)
	    }, setModifier, {}, (function (){
	        console.log(" ... updated "+(doc.name?doc.name+" ":"")+"with tvSeasonInfo for season "+season_number);
	    }).bind(undefined, season_number));
	} else if(season_number) {

		// update timestamp only
		var setModifier = { $set: {} };
		setModifier.$set["season."+season_number+".timestamp"] = Date.now();
		db.shows.update({
		    id: parseInt(doc.id)
		}, setModifier, {}, (function (){
		    console.log(" ... updated "+(doc.name?doc.name+" ":"")+"with empty tvSeasonInfo for season "+season_number);
		}).bind(undefined, season_number));
	}

	return doc;
}

function get_specific_episode(show, season_number, episode_number, callback) {
	if(season_number && episode_number){
	    // everything taken care of for getting this season
	    if(show && show.season && show.season[season_number] && show.season[season_number].episode && show.season[season_number].episode[episode_number]) callback(show.season[season_number].episode[episode_number], show)
	    else get_seasons(show, (function(callback, season_number, episode_number, show) {
	    	if(show && show.season && show.season[season_number] && show.season[season_number].episode && show.season[season_number].episode[episode_number]) callback(show.season[season_number].episode[episode_number], show)
	        else get_episodes(show, season_number, (function(callback, season_number, episode_number, show) {
	            if (show.season && show.season[season_number] && show.season[season_number].episode && show.season[season_number].episode[episode_number]) callback(show.season[season_number].episode[episode_number], show)
	            else callback(false, show)
	        }).bind(undefined, callback, season_number, episode_number))
	    }).bind(undefined, callback, season_number, episode_number))
	} else callback(false, show)
}

function get_episodes(show, season_number, callback) {
	if(season_number){
	    // should i go fetch new data for the season
	    get_seasons(show, (function(callback, season_number, show) {
	        if (show.season && show.season[season_number] && (!show.season[season_number].timestamp || check_time_with(show.season[season_number].timestamp, season_expiration) == -1 )) detail_season(season_number, show, callback)
	        else callback(show);
	    }).bind(undefined, callback, season_number))
	} else callback(show);
}

function detail_season(season_number, doc, callback) {
    // fetch new data for the season
    console.log("updating tvSeasonInfo for season " + season_number + " --------------- > internet connection (mdb)")
    if(!mdb) mdb = require('moviedb')(mdb_API_key);
    mdb.tvSeasonInfo({
        id: doc.id,
        season_number: season_number
    }, (function(callback, season_number, doc, err, res) {
        doc = update_doc_with_seasonInfo(doc, res, season_number)
        callback(doc);
    }).bind(undefined, callback, season_number, doc))
}

function update_doc_with_tvInfo(doc, res) {
    // updates the doc with new data for the season
    if(res){
	    if (!doc) doc = {};
	    doc["name"] = res.name;
	    doc["id"] = parseInt(res.id);
	    doc["poster_path"] = res.poster_path;
	    doc["first_air_date"] = res.first_air_date;
	    doc["country"] = res.origin_country;
	    doc["popularity"] = res.popularity;
	    doc["timestamp"] = Date.now();
	    doc["created_by"] = res.created_by;
	    doc["genres"] = res.genres;
	    doc["last_air_date"] = res.last_air_date;
	    doc["number_of_episodes"] = res.number_of_episodes;
	    doc["number_of_seasons"] = res.number_of_seasons;
	    doc["overview"] = res.overview;
	    doc["popularity"] = res.popularity;
	    doc["vote_average"] = res.vote_average;
	    doc["status"] = res.status;
	    if (!doc["season"]) doc["season"] = {};
	    for (var i = 0, l = res.seasons.length; i < l; i++) {
	    	if(res.seasons[i].season_number!=0){
		        if (!doc["season"]["" + res.seasons[i].season_number + ""]) doc["season"]["" + res.seasons[i].season_number + ""] = {};
		        doc["season"]["" + res.seasons[i].season_number + ""]["season_number"] = res.seasons[i].season_number;
		        doc["season"]["" + res.seasons[i].season_number + ""]["poster_path"] = res.seasons[i].poster_path;
		        doc["season"]["" + res.seasons[i].season_number + ""]["air_date"] = res.seasons[i].air_date;
		    }
	    };

	    // update database with new data for the season
	    var setModifier = { $set: {} };
	    setModifier.$set["name"] = res.name;
	    setModifier.$set["id"] = parseInt(res.id);
	    setModifier.$set["poster_path"] = res.poster_path;
	    setModifier.$set["first_air_date"] = res.first_air_date;
	    setModifier.$set["country"] = res.origin_country;
	    setModifier.$set["popularity"] = res.popularity;
	    setModifier.$set["timestamp"] = Date.now();
	    setModifier.$set["created_by"] = res.created_by;
	    setModifier.$set["genres"] = res.genres;
	    setModifier.$set["last_air_date"] = res.last_air_date;
	    setModifier.$set["number_of_episodes"] = res.number_of_episodes;
	    setModifier.$set["number_of_seasons"] = res.number_of_seasons;
	    setModifier.$set["overview"] = res.overview;
	    setModifier.$set["popularity"] = res.popularity;
	    setModifier.$set["vote_average"] = res.vote_average;
	    setModifier.$set["status"] = res.status;
	    for (var i = 0, l = res.seasons.length; i < l; i++) {
	    	if(res.seasons[i].season_number && res.seasons[i].season_number!=0){
		    	setModifier.$set["season."+res.seasons[i].season_number+".season_number"] = res.seasons[i].season_number;
		    	setModifier.$set["season."+res.seasons[i].season_number+".poster_path"] = res.seasons[i].poster_path;
		    	setModifier.$set["season."+res.seasons[i].season_number+".air_date"] = res.seasons[i].air_date;
		    }
	    }
	    db.shows.update({
	    	id: parseInt(doc.id)
	    }, setModifier, { upsert: true }, function (){
	    	console.log(" ... updated "+(doc.name?doc.name:"")+" with tv_info");
	    });
	} else {

		// update timestamp only
		var setModifier = { $set: {} };
		setModifier.$set["timestamp"] = Date.now();
		db.shows.update({
			id: parseInt(doc.id)
		}, setModifier, {}, function (){
			console.log(" ... updated "+(doc.name?doc.name:"")+" with empty tv_info");
		});
	}

    return doc;
}

function search_on_mdb (query, callback) {
	console.log("search_on_mdb "+query);
	if(!db.queries_history) db.queries_history = new Datastore({ filename: w.cache+"/queries_history.db", autoload: true });
	db.queries_history.findOne({ query: query.trim() }, (function (callback, query, err, doc) {
		if(doc && check_time_with(doc.timestamp, search_expiration) == 1 ){
			callback(doc.results || false);
		} else {
			// do the actual search
			console.log("------------------------------------ > internet connection (mdb)")
			if(!mdb) mdb = require('moviedb')(mdb_API_key);
			mdb[(query=='miscTopRatedTvs'?'miscTopRatedTvs':'searchTv')]((query=='miscTopRatedTvs'?{}:{query: query.trim(), page: 1, search_type: "ngram"}), (function (callback, query, err, res) {
					callback(res.results || false);

					// store query
					db.queries_history.update({
						query: query.trim()
					}, {
						query: query.trim(),
						timestamp: Date.now(),
						results: res.results
					}, { upsert: true });

					// update shows with info contained in this query
					if(!db.shows) db.shows = new Datastore({ filename: w.data+"/shows.db", autoload: true });

					if(query=='miscTopRatedTvs'){
						console.log("query was miscTopRatedTvs");
						// remove previous "top" results before adding the new ones
						db.shows.update({ top: { $exists: true } }, { $unset: { top: true } }, {}, function(){
							for (var i = 0, l = res.results.length; i < l; i++) {
								if(good_enough_show(res.results[i])){
									db.shows.update({
										id: parseInt(res.results[i].id)
									}, { $set: {
										name: res.results[i].name,
										id: parseInt(res.results[i].id),
										poster_path: res.results[i].poster_path,
										first_air_date: res.results[i].first_air_date,
										country: res.results[i].origin_country,
										vote_average: res.results[i].vote_average,
										popularity: res.results[i].popularity,
										top: i+1
									} }, { upsert: true });
								}
								if(res.results[i].poster_path) delayed_images.push({"id": parseInt(res.results[i].id), "path": res.results[i].poster_path});
							}
						})
					} else {
						for (var i = 0, l = res.results.length; i < l; i++) {
							if(good_enough_show(res.results[i])){
								db.shows.update({
									id: parseInt(res.results[i].id)
								}, { $set: {
									name: res.results[i].name,
									id: parseInt(res.results[i].id),
									poster_path: res.results[i].poster_path,
									first_air_date: res.results[i].first_air_date,
									country: res.results[i].origin_country,
									vote_average: res.results[i].vote_average,
									popularity: res.results[i].popularity
								} }, { upsert: true });
							}
							if(res.results[i].poster_path) delayed_images.push({"id": parseInt(res.results[i].id), "path": res.results[i].poster_path});
						};
					}



				}).bind(undefined, callback, query)
			);
		}
	}).bind(undefined, callback, query));
}

function get_magnet (show, episode, callback) {
	callback = callback || function(){};
	if(show && episode && ((episode.air_date && check_time_with(date_from_tmdb_format(episode.air_date), 0) == -1) || !episode.air_date)){
		if(episode.magnet && check_time_with(episode.magnet.timestamp, magnet_expiration) == 1 && !((!episode.magnet.piratebay || episode.magnet.piratebay===false) && check_time_with(episode.magnet.timestamp, no_magnet_recheck) == -1)){
			callback(episode.magnet);
		}else{
			function find_best_in_list (show, episode, results) {
				if(results.error){
					return {
						timestamp: Date.now(),
						error: results.error
					}
				} else {
					var regexed_name = show.name.replace(/[^a-zA-Z0-9 ]/g, '.?')
					regexed_name = regexed_name.replace(/[ ]/g, "[. ]?");
					var re = new RegExp(regexed_name+"(([^a-zA-Z0-9]+)?((19|20)?[0-9]{2})([^a-zA-Z0-9]+)?)?[. ]*?s"+leading_zero(episode.season_number)+"e"+leading_zero(episode.episode_number), "i");

					var found = false;
					for (var i = 0, l = results.length; i < l; i++) {
						var match = (results[i].name || results[i].title).match(re);
						if(match && match.length>0){
							found = true;
							break;
						}
					};

					if(found && !results[i].name){ // convert kickass to piratebay format
						results[i] = {
						    "name": results[i].title,
						    "uploadDate": results[i].pubDate,
						    "size": results[i].size,
						    "seeders": results[i].seeds,
						    "leechers": results[i].leechs,
						    "link": results[i].link,
						    "magnetLink": "magnet:?xt=urn:btih:"+results[i].hash
						}
					}

					return {
						"timestamp": Date.now(),
						"piratebay": (found?results[i]:false)
					}
				}
			}
			var magnets = [];
			var parallel = new Parallel()
				.add(function (done) {
					search_kickass(show.name+" "+formatted_episode_number(episode), (function (show, episode, results) {
						if(results && results.length>0)
							magnets.push(find_best_in_list(show, episode, results));
						done();
					}).bind(undefined, show, episode));
				})
				.add(function (done) {
					search_piratebay(show.name+" "+formatted_episode_number(episode)+"*", (function (show, episode, results) {
						if(results && results.length>0)
							magnets.push(find_best_in_list(show, episode, results));
						done();
					}).bind(undefined, show, episode));
				})
			parallel.done(function () {
				var magnet = {};

				// no connection
				var unreachable = true;
				for (var i = magnets.length - 1; i >= 0; i--) {
					if(!magnets[i].error){
						unreachable = false;
						break;
					}
				};
				if(unreachable && magnets.length>0){
					if(episode.magnet && episode.magnet.piratebay){
						magnet = episode.magnet;
					} else {
						magnet = {
							timestamp: Date.now(),
							error: magnets[0].error
						};
					}
				}
				// no result
				var none = true;
				for (var i = magnets.length - 1; i >= 0; i--) {
					if(magnets[i].piratebay){
						none = false;
						break;
					}
				};
				if(none){
					if(episode.magnet && episode.magnet.piratebay){
						magnet = episode.magnet;
					} else {
						magnet = {
							timestamp: Date.now(),
							piratebay: false
						};
					}
				}

				// best result
				if(!none && !unreachable){
					magnet = magnets[0];
					for (var i = magnets.length - 1; i > 0; i--) {
						if(magnet.piratebay && magnets[i].piratebay && magnets[i].piratebay.seeders > magnet.piratebay.seeders)
							magnet = magnets[i];
					};
				}

				// send to work
				callback(magnet);

				// log in db
				if(episode.season_number && episode.episode_number){
					var setModifier = { $set: {} };
					setModifier.$set["season."+episode.season_number+".episode."+episode.episode_number+".magnet"] = magnet;
					db.shows.update({
						id: parseInt(show.id)
					}, setModifier, { upsert: true }, function (){
						if(magnet.error || !magnet.piratebay)
							console.log(" ... no magnet for "+(show.name?show.name:""));
						else
							console.log(" ... new magnet for "+(show.name?show.name:""));
					});
				}
			})
		}
	} else {
		callback({
			"timestamp": Date.now(),
			"piratebay": false
		});
	}
}

function get_magnets_for_season (show, season_number, callback) {
	if(season_number){
		get_episodes(show, season_number, function (show) {
			if(show.season && show.season[""+season_number+""] && show.season[""+season_number+""].episode){
				var keys = Object.keys(show.season[""+season_number+""].episode);
				var has_em_all = true;
				var lonely_episode = false;
				for (var i = 0, l = keys.length; i < l; i++) {
					var temp_episode = show.season[""+season_number+""].episode[keys[i]];
					if(temp_episode.air_date && check_time_with(date_from_tmdb_format(temp_episode.air_date), 0) == -1 && (!temp_episode.magnet || !temp_episode.magnet.piratebay || check_time_with(temp_episode.magnet.timestamp, magnet_expiration) == -1 )){
						has_em_all = false;
						if(lonely_episode){
							lonely_episode = false;
							break;
						} else {
							lonely_episode = temp_episode;
						}
					}
				};
				if(has_em_all){
					callback(show);
				}
				else if(lonely_episode){
					get_magnet(show, lonely_episode, (function (callback, show, episode, magnet) {
						show["season"][""+episode.season_number+""]["episode"][""+episode.episode_number+""].magnet = magnet;
						callback(show);
					}).bind(undefined, callback, show, lonely_episode))
				} else {
					var magnets = [];
					function find_bests_in_list (show, season_number, results) {
						var updated_episodes = [];
						for (var i = 0, l = results.length; i < l; i++) {
							var regexed_name = show.name.replace(/[^a-zA-Z0-9 ]/g, '*?')
							regexed_name = regexed_name.replace(/[ ]/g, "[. ]?");
							var re = new RegExp(regexed_name+"[. ]?s[0-9]{2}e[0-9]{2}", "i");
							var match = (results[i].name || results[i].title).match(re);
							if(match && match.length>0){
								var match = (results[i].name || results[i].title).match(/s[0-9]{2}e[0-9]{2}/i);
								var numbers = match[0].match(/[0-9]{2}/g)
								if(season_number==parseInt(numbers[0]) && updated_episodes.indexOf(parseInt(numbers[1]))==-1 && ( !magnets[""+parseInt(numbers[1])+""] || magnets[""+parseInt(numbers[1])+""].seeders < (results[i].seeders || results[i].seeds) )){
									updated_episodes.push(parseInt(numbers[1]));
									if(!results[i].name){ // convert kickass to piratebay format
										results[i] = {
											"name": results[i].title,
											"uploadDate": results[i].pubDate,
											"size": results[i].size,
											"seeders": results[i].seeds,
											"leechers": results[i].leechs,
											"link": results[i].link,
											"magnetLink": "magnet:?xt=urn:btih:"+results[i].hash
										}
									}
									magnets[""+numbers[1]+""] = {
										"timestamp": Date.now(),
										"piratebay": results[i]
									}
								}
							}
						};
					}
					var parallel = new Parallel()
						.add(function (done) {
							search_kickass(show.name+" S"+leading_zero(season_number)+"E", function (results) {
								if(results && results.length>0)
									find_bests_in_list(show, season_number, results);
								done();
							})
						})
						.add(function (done) {
							search_piratebay(show.name+" S"+leading_zero(season_number)+"E*", function (results) {
								if(results && results.length>0)
									find_bests_in_list(show, season_number, results);
								done();
							})
						})
					parallel.done(function () {
						var setModifier = { $set: {} };
						var mag_keys = Object.keys(magnets);
						var updated_episodes = "";
						if(show.season && show.season[""+season_number+""] && show.season[""+season_number+""].episode){
							for (var i = mag_keys.length - 1; i >= 0; i--) {
								if(show["season"][""+season_number+""]["episode"][""+mag_keys[i]+""]){
									updated_episodes += " "+mag_keys[i];
									show["season"][""+season_number+""]["episode"][""+mag_keys[i]+""].magnet = magnets[mag_keys[i]];
									setModifier.$set["season."+season_number+".episode."+mag_keys[i]+".magnet"] = magnets[mag_keys[i]];
								}
							};
						}
						callback(show);

						//log in db
						db.shows.update({
							id: parseInt(show.id)
						}, setModifier, { upsert: true }, function (){
							console.log(" ... updated all magnets for "+(show.name?show.name:"")+" season "+season_number+ (updated_episodes?" (episodes"+updated_episodes+")":""));
						});
					})
				}
			} else callback(show);
		});
	} else callback(show);
}


////////////////////////////////////////
//  DEAL WITH PIRATEBAY'S HTML INPUT  //
////////////////////////////////////////

var Latinise = {"Á":"A","Ă":"A","Ắ":"A","Ặ":"A","Ằ":"A","Ẳ":"A","Ẵ":"A","Ǎ":"A","Â":"A","Ấ":"A","Ậ":"A","Ầ":"A","Ẩ":"A","Ẫ":"A","Ä":"A","Ǟ":"A","Ȧ":"A","Ǡ":"A","Ạ":"A","Ȁ":"A","À":"A","Ả":"A","Ȃ":"A","Ā":"A","Ą":"A","Å":"A","Ǻ":"A","Ḁ":"A","Ⱥ":"A","Ã":"A","Ꜳ":"AA","Æ":"AE","Ǽ":"AE","Ǣ":"AE","Ꜵ":"AO","Ꜷ":"AU","Ꜹ":"AV","Ꜻ":"AV","Ꜽ":"AY","Ḃ":"B","Ḅ":"B","Ɓ":"B","Ḇ":"B","Ƀ":"B","Ƃ":"B","Ć":"C","Č":"C","Ç":"C","Ḉ":"C","Ĉ":"C","Ċ":"C","Ƈ":"C","Ȼ":"C","Ď":"D","Ḑ":"D","Ḓ":"D","Ḋ":"D","Ḍ":"D","Ɗ":"D","Ḏ":"D","ǲ":"D","ǅ":"D","Đ":"D","Ƌ":"D","Ǳ":"DZ","Ǆ":"DZ","É":"E","Ĕ":"E","Ě":"E","Ȩ":"E","Ḝ":"E","Ê":"E","Ế":"E","Ệ":"E","Ề":"E","Ể":"E","Ễ":"E","Ḙ":"E","Ë":"E","Ė":"E","Ẹ":"E","Ȅ":"E","È":"E","Ẻ":"E","Ȇ":"E","Ē":"E","Ḗ":"E","Ḕ":"E","Ę":"E","Ɇ":"E","Ẽ":"E","Ḛ":"E","Ꝫ":"ET","Ḟ":"F","Ƒ":"F","Ǵ":"G","Ğ":"G","Ǧ":"G","Ģ":"G","Ĝ":"G","Ġ":"G","Ɠ":"G","Ḡ":"G","Ǥ":"G","Ḫ":"H","Ȟ":"H","Ḩ":"H","Ĥ":"H","Ⱨ":"H","Ḧ":"H","Ḣ":"H","Ḥ":"H","Ħ":"H","Í":"I","Ĭ":"I","Ǐ":"I","Î":"I","Ï":"I","Ḯ":"I","İ":"I","Ị":"I","Ȉ":"I","Ì":"I","Ỉ":"I","Ȋ":"I","Ī":"I","Į":"I","Ɨ":"I","Ĩ":"I","Ḭ":"I","Ꝺ":"D","Ꝼ":"F","Ᵹ":"G","Ꞃ":"R","Ꞅ":"S","Ꞇ":"T","Ꝭ":"IS","Ĵ":"J","Ɉ":"J","Ḱ":"K","Ǩ":"K","Ķ":"K","Ⱪ":"K","Ꝃ":"K","Ḳ":"K","Ƙ":"K","Ḵ":"K","Ꝁ":"K","Ꝅ":"K","Ĺ":"L","Ƚ":"L","Ľ":"L","Ļ":"L","Ḽ":"L","Ḷ":"L","Ḹ":"L","Ⱡ":"L","Ꝉ":"L","Ḻ":"L","Ŀ":"L","Ɫ":"L","ǈ":"L","Ł":"L","Ǉ":"LJ","Ḿ":"M","Ṁ":"M","Ṃ":"M","Ɱ":"M","Ń":"N","Ň":"N","Ņ":"N","Ṋ":"N","Ṅ":"N","Ṇ":"N","Ǹ":"N","Ɲ":"N","Ṉ":"N","Ƞ":"N","ǋ":"N","Ñ":"N","Ǌ":"NJ","Ó":"O","Ŏ":"O","Ǒ":"O","Ô":"O","Ố":"O","Ộ":"O","Ồ":"O","Ổ":"O","Ỗ":"O","Ö":"O","Ȫ":"O","Ȯ":"O","Ȱ":"O","Ọ":"O","Ő":"O","Ȍ":"O","Ò":"O","Ỏ":"O","Ơ":"O","Ớ":"O","Ợ":"O","Ờ":"O","Ở":"O","Ỡ":"O","Ȏ":"O","Ꝋ":"O","Ꝍ":"O","Ō":"O","Ṓ":"O","Ṑ":"O","Ɵ":"O","Ǫ":"O","Ǭ":"O","Ø":"O","Ǿ":"O","Õ":"O","Ṍ":"O","Ṏ":"O","Ȭ":"O","Ƣ":"OI","Ꝏ":"OO","Ɛ":"E","Ɔ":"O","Ȣ":"OU","Ṕ":"P","Ṗ":"P","Ꝓ":"P","Ƥ":"P","Ꝕ":"P","Ᵽ":"P","Ꝑ":"P","Ꝙ":"Q","Ꝗ":"Q","Ŕ":"R","Ř":"R","Ŗ":"R","Ṙ":"R","Ṛ":"R","Ṝ":"R","Ȑ":"R","Ȓ":"R","Ṟ":"R","Ɍ":"R","Ɽ":"R","Ꜿ":"C","Ǝ":"E","Ś":"S","Ṥ":"S","Š":"S","Ṧ":"S","Ş":"S","Ŝ":"S","Ș":"S","Ṡ":"S","Ṣ":"S","Ṩ":"S","Ť":"T","Ţ":"T","Ṱ":"T","Ț":"T","Ⱦ":"T","Ṫ":"T","Ṭ":"T","Ƭ":"T","Ṯ":"T","Ʈ":"T","Ŧ":"T","Ɐ":"A","Ꞁ":"L","Ɯ":"M","Ʌ":"V","Ꜩ":"TZ","Ú":"U","Ŭ":"U","Ǔ":"U","Û":"U","Ṷ":"U","Ü":"U","Ǘ":"U","Ǚ":"U","Ǜ":"U","Ǖ":"U","Ṳ":"U","Ụ":"U","Ű":"U","Ȕ":"U","Ù":"U","Ủ":"U","Ư":"U","Ứ":"U","Ự":"U","Ừ":"U","Ử":"U","Ữ":"U","Ȗ":"U","Ū":"U","Ṻ":"U","Ų":"U","Ů":"U","Ũ":"U","Ṹ":"U","Ṵ":"U","Ꝟ":"V","Ṿ":"V","Ʋ":"V","Ṽ":"V","Ꝡ":"VY","Ẃ":"W","Ŵ":"W","Ẅ":"W","Ẇ":"W","Ẉ":"W","Ẁ":"W","Ⱳ":"W","Ẍ":"X","Ẋ":"X","Ý":"Y","Ŷ":"Y","Ÿ":"Y","Ẏ":"Y","Ỵ":"Y","Ỳ":"Y","Ƴ":"Y","Ỷ":"Y","Ỿ":"Y","Ȳ":"Y","Ɏ":"Y","Ỹ":"Y","Ź":"Z","Ž":"Z","Ẑ":"Z","Ⱬ":"Z","Ż":"Z","Ẓ":"Z","Ȥ":"Z","Ẕ":"Z","Ƶ":"Z","Ĳ":"IJ","Œ":"OE","ᴀ":"A","ᴁ":"AE","ʙ":"B","ᴃ":"B","ᴄ":"C","ᴅ":"D","ᴇ":"E","ꜰ":"F","ɢ":"G","ʛ":"G","ʜ":"H","ɪ":"I","ʁ":"R","ᴊ":"J","ᴋ":"K","ʟ":"L","ᴌ":"L","ᴍ":"M","ɴ":"N","ᴏ":"O","ɶ":"OE","ᴐ":"O","ᴕ":"OU","ᴘ":"P","ʀ":"R","ᴎ":"N","ᴙ":"R","ꜱ":"S","ᴛ":"T","ⱻ":"E","ᴚ":"R","ᴜ":"U","ᴠ":"V","ᴡ":"W","ʏ":"Y","ᴢ":"Z","á":"a","ă":"a","ắ":"a","ặ":"a","ằ":"a","ẳ":"a","ẵ":"a","ǎ":"a","â":"a","ấ":"a","ậ":"a","ầ":"a","ẩ":"a","ẫ":"a","ä":"a","ǟ":"a","ȧ":"a","ǡ":"a","ạ":"a","ȁ":"a","à":"a","ả":"a","ȃ":"a","ā":"a","ą":"a","ᶏ":"a","ẚ":"a","å":"a","ǻ":"a","ḁ":"a","ⱥ":"a","ã":"a","ꜳ":"aa","æ":"ae","ǽ":"ae","ǣ":"ae","ꜵ":"ao","ꜷ":"au","ꜹ":"av","ꜻ":"av","ꜽ":"ay","ḃ":"b","ḅ":"b","ɓ":"b","ḇ":"b","ᵬ":"b","ᶀ":"b","ƀ":"b","ƃ":"b","ɵ":"o","ć":"c","č":"c","ç":"c","ḉ":"c","ĉ":"c","ɕ":"c","ċ":"c","ƈ":"c","ȼ":"c","ď":"d","ḑ":"d","ḓ":"d","ȡ":"d","ḋ":"d","ḍ":"d","ɗ":"d","ᶑ":"d","ḏ":"d","ᵭ":"d","ᶁ":"d","đ":"d","ɖ":"d","ƌ":"d","ı":"i","ȷ":"j","ɟ":"j","ʄ":"j","ǳ":"dz","ǆ":"dz","é":"e","ĕ":"e","ě":"e","ȩ":"e","ḝ":"e","ê":"e","ế":"e","ệ":"e","ề":"e","ể":"e","ễ":"e","ḙ":"e","ë":"e","ė":"e","ẹ":"e","ȅ":"e","è":"e","ẻ":"e","ȇ":"e","ē":"e","ḗ":"e","ḕ":"e","ⱸ":"e","ę":"e","ᶒ":"e","ɇ":"e","ẽ":"e","ḛ":"e","ꝫ":"et","ḟ":"f","ƒ":"f","ᵮ":"f","ᶂ":"f","ǵ":"g","ğ":"g","ǧ":"g","ģ":"g","ĝ":"g","ġ":"g","ɠ":"g","ḡ":"g","ᶃ":"g","ǥ":"g","ḫ":"h","ȟ":"h","ḩ":"h","ĥ":"h","ⱨ":"h","ḧ":"h","ḣ":"h","ḥ":"h","ɦ":"h","ẖ":"h","ħ":"h","ƕ":"hv","í":"i","ĭ":"i","ǐ":"i","î":"i","ï":"i","ḯ":"i","ị":"i","ȉ":"i","ì":"i","ỉ":"i","ȋ":"i","ī":"i","į":"i","ᶖ":"i","ɨ":"i","ĩ":"i","ḭ":"i","ꝺ":"d","ꝼ":"f","ᵹ":"g","ꞃ":"r","ꞅ":"s","ꞇ":"t","ꝭ":"is","ǰ":"j","ĵ":"j","ʝ":"j","ɉ":"j","ḱ":"k","ǩ":"k","ķ":"k","ⱪ":"k","ꝃ":"k","ḳ":"k","ƙ":"k","ḵ":"k","ᶄ":"k","ꝁ":"k","ꝅ":"k","ĺ":"l","ƚ":"l","ɬ":"l","ľ":"l","ļ":"l","ḽ":"l","ȴ":"l","ḷ":"l","ḹ":"l","ⱡ":"l","ꝉ":"l","ḻ":"l","ŀ":"l","ɫ":"l","ᶅ":"l","ɭ":"l","ł":"l","ǉ":"lj","ſ":"s","ẜ":"s","ẛ":"s","ẝ":"s","ḿ":"m","ṁ":"m","ṃ":"m","ɱ":"m","ᵯ":"m","ᶆ":"m","ń":"n","ň":"n","ņ":"n","ṋ":"n","ȵ":"n","ṅ":"n","ṇ":"n","ǹ":"n","ɲ":"n","ṉ":"n","ƞ":"n","ᵰ":"n","ᶇ":"n","ɳ":"n","ñ":"n","ǌ":"nj","ó":"o","ŏ":"o","ǒ":"o","ô":"o","ố":"o","ộ":"o","ồ":"o","ổ":"o","ỗ":"o","ö":"o","ȫ":"o","ȯ":"o","ȱ":"o","ọ":"o","ő":"o","ȍ":"o","ò":"o","ỏ":"o","ơ":"o","ớ":"o","ợ":"o","ờ":"o","ở":"o","ỡ":"o","ȏ":"o","ꝋ":"o","ꝍ":"o","ⱺ":"o","ō":"o","ṓ":"o","ṑ":"o","ǫ":"o","ǭ":"o","ø":"o","ǿ":"o","õ":"o","ṍ":"o","ṏ":"o","ȭ":"o","ƣ":"oi","ꝏ":"oo","ɛ":"e","ᶓ":"e","ɔ":"o","ᶗ":"o","ȣ":"ou","ṕ":"p","ṗ":"p","ꝓ":"p","ƥ":"p","ᵱ":"p","ᶈ":"p","ꝕ":"p","ᵽ":"p","ꝑ":"p","ꝙ":"q","ʠ":"q","ɋ":"q","ꝗ":"q","ŕ":"r","ř":"r","ŗ":"r","ṙ":"r","ṛ":"r","ṝ":"r","ȑ":"r","ɾ":"r","ᵳ":"r","ȓ":"r","ṟ":"r","ɼ":"r","ᵲ":"r","ᶉ":"r","ɍ":"r","ɽ":"r","ↄ":"c","ꜿ":"c","ɘ":"e","ɿ":"r","ś":"s","ṥ":"s","š":"s","ṧ":"s","ş":"s","ŝ":"s","ș":"s","ṡ":"s","ṣ":"s","ṩ":"s","ʂ":"s","ᵴ":"s","ᶊ":"s","ȿ":"s","ɡ":"g","ᴑ":"o","ᴓ":"o","ᴝ":"u","ť":"t","ţ":"t","ṱ":"t","ț":"t","ȶ":"t","ẗ":"t","ⱦ":"t","ṫ":"t","ṭ":"t","ƭ":"t","ṯ":"t","ᵵ":"t","ƫ":"t","ʈ":"t","ŧ":"t","ᵺ":"th","ɐ":"a","ᴂ":"ae","ǝ":"e","ᵷ":"g","ɥ":"h","ʮ":"h","ʯ":"h","ᴉ":"i","ʞ":"k","ꞁ":"l","ɯ":"m","ɰ":"m","ᴔ":"oe","ɹ":"r","ɻ":"r","ɺ":"r","ⱹ":"r","ʇ":"t","ʌ":"v","ʍ":"w","ʎ":"y","ꜩ":"tz","ú":"u","ŭ":"u","ǔ":"u","û":"u","ṷ":"u","ü":"u","ǘ":"u","ǚ":"u","ǜ":"u","ǖ":"u","ṳ":"u","ụ":"u","ű":"u","ȕ":"u","ù":"u","ủ":"u","ư":"u","ứ":"u","ự":"u","ừ":"u","ử":"u","ữ":"u","ȗ":"u","ū":"u","ṻ":"u","ų":"u","ᶙ":"u","ů":"u","ũ":"u","ṹ":"u","ṵ":"u","ᵫ":"ue","ꝸ":"um","ⱴ":"v","ꝟ":"v","ṿ":"v","ʋ":"v","ᶌ":"v","ⱱ":"v","ṽ":"v","ꝡ":"vy","ẃ":"w","ŵ":"w","ẅ":"w","ẇ":"w","ẉ":"w","ẁ":"w","ⱳ":"w","ẘ":"w","ẍ":"x","ẋ":"x","ᶍ":"x","ý":"y","ŷ":"y","ÿ":"y","ẏ":"y","ỵ":"y","ỳ":"y","ƴ":"y","ỷ":"y","ỿ":"y","ȳ":"y","ẙ":"y","ɏ":"y","ỹ":"y","ź":"z","ž":"z","ẑ":"z","ʑ":"z","ⱬ":"z","ż":"z","ẓ":"z","ȥ":"z","ẕ":"z","ᵶ":"z","ᶎ":"z","ʐ":"z","ƶ":"z","ɀ":"z","ﬀ":"ff","ﬃ":"ffi","ﬄ":"ffl","ﬁ":"fi","ﬂ":"fl","ĳ":"ij","œ":"oe","ﬆ":"st","ₐ":"a","ₑ":"e","ᵢ":"i","ⱼ":"j","ₒ":"o","ᵣ":"r","ᵤ":"u","ᵥ":"v","ₓ":"x"};

function search_kickass (query, callback) {
	//remove accents
	query = query.replace(/[^A-Za-z0-9\[\] ]/g,function(a){return Latinise[a]||a});
	//general tidy
	query = query.replace(/(?!((([A-Z]|\.){2,})))(([^a-zA-Z0-9 \-\.]+)|(\b[^0-9 \-]\b)|(\b[^\b\s]+?\b'[a-zA-Z])|([-\.]+))/g, ' ');
	//specific cases
	query = query.replace(/\b ish\b/g, 'ish');
	//multiple spaces
	query = query.replace(/ {2,}/g, ' ');
	console.log("------------------------- > internet connection (kickass), querying '"+query+"'")
	if(!request) request = require('request');
	request({
			url: 'https://kickass.so/json.php?field=seeders&order=desc&q='+query.trim(),
			timeout: 2000,
			json: true
		}, (function (callback, error, response, body) {
			if (!error && response && response.statusCode == 200) {
				callback(response.body.list);
			} else {
				console.log("kickass error with "+query);
				callback({error: true});
			}
		}).bind(undefined, callback)
	);
}

function search_piratebay (query, callback) {
	//remove accents
	query = query.replace(/[^A-Za-z0-9\[\] ]/g,function(a){return Latinise[a]||a});
	//general tidy
	query = query.replace(/(?!((([A-Z]|\.){2,})|(\*$)))(([^a-zA-Z0-9 \-\.]+)|(\b[^0-9 \-]\b)|(\b[^\b\s]+?\b'[a-zA-Z])|([-\.]+))/g, ' ');
	//specific cases
	query = query.replace(/\b ish\b/g, 'ish');
	//multiple spaces
	query = query.replace(/ {2,}/g, ' ');
	console.log("------------------------- > internet connection (tpb), querying '"+query+"'")
	if(!request) request = require('request');
	request({
			url: 'http://thepiratebay.cr/search/'+query.trim()+'/0/7/'+video_quality,
			gzip: 'true',
			timeout: 2000
		}, (function (callback, error, response, body) {
			if (!error && response && response.statusCode == 200) {
				var results = crawl_piratebay_html(body);
				callback(results);
			} else {
				console.log("piratebay error with "+query);
				callback({error: true});
			}
		}).bind(undefined, callback)
	);
}

function crawl_piratebay_html (html) {
	if(!cheerio) cheerio = require('cheerio');
	var $ = cheerio.load(html),
	results = new Array();
	$('table#searchResult tr:has(a.detLink)').each(function(i, elem) {
		var seeders = parseInt($(this).find('td[align="right"]').first().text());
		if(seeders>1){
			results.push({
				"name": $(this).find('a.detLink').text(),
				"uploadDate": $(this).find('font').text().match(/Uploaded\s(?:<b>)?(.+?)(?:<\/b>)?,/)[1],
				"size": $(this).find('font').text().match(/Size (.+?),/)[1],
				"seeders": seeders,
				"leechers": $(this).find('td[align="right"]').next().text(),
				"link": $(this).find('div.detName a').attr('href'),
				"magnetLink": $(this).find('a[title="Download this torrent using magnet"]').attr('href')
				// "category": {
				// 	"id": $(this).find('center a').first().attr('href').match(/\/browse\/(\d+)/)[1],
				// 	"name": $(this).find('center a').first().text(),
				// },
				// "subcategory": {
				// 	"id": $(this).find('center a').last().attr('href').match(/\/browse\/(\d+)/)[1],
				// 	"name": $(this).find('center a').last().text(),
				// }
			});
		}
	});
	return results;
}


/////////////////////////////////////
//  DEAL WITH ALFRED'S XML OUTPUT  //
/////////////////////////////////////

function alfred_xml (bundleid) {
	this.cache = process.env.HOME + "/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow Data/" + bundleid;
	this.data = process.env.HOME + "/Library/Application Support/Alfred 2/Workflow Data/" + bundleid;
	this.results = [];
	this.order = [];
	this.xml = "";

	var XML_CHAR_MAP = {
		'<': '&lt;',
		'>': '&gt;',
		'&': '&amp;',
		'"': '&quot;',
		"'": '&apos;'
	};

	function escapeXml (s) {
		return (""+s+"").replace(/[<>&"']/g, function (ch) {
			return XML_CHAR_MAP[ch];
		});
	}

	this.result = function () {
		this.uid;
		this.arg;
		this.valid = "YES";
		this.autocomplete;
		this.type;

		this.title = "Title";
		this.subtitle;
		this.icontype;
		this.icon;

		this.shift;
		this.fn;
		this.ctrl;
		this.alt;
		this.cmd;
		this.copy;
		this.largetype;

		this.item_xml = "";
		this.indexed = false;

		this.toXML = function () {
			if(this.uid) this.uid = escapeXml(this.uid);
			if(this.arg) this.arg = escapeXml(this.arg);
			if(this.valid) this.valid = escapeXml(this.valid);
			if(this.autocomplete) this.autocomplete = escapeXml(this.autocomplete);
			if(this.type) this.type = escapeXml(this.type);
			if(this.title) this.title = escapeXml(this.title);
			if(this.subtitle) this.subtitle = escapeXml(this.subtitle);
			if(this.icontype) this.icontype = escapeXml(this.icontype);
			if(this.icon) this.icon = escapeXml(this.icon);
			if(this.shift) this.shift = escapeXml(this.shift);
			if(this.fn) this.fn = escapeXml(this.fn);
			if(this.ctrl) this.ctrl = escapeXml(this.ctrl);
			if(this.alt) this.alt = escapeXml(this.alt);
			if(this.cmd) this.cmd = escapeXml(this.cmd);
			if(this.copy) this.copy = escapeXml(this.copy);
			if(this.largetype) this.largetype = escapeXml(this.largetype);

			// uncomment the following as needed based on what is declared in the workflow
			this.shift = this.shift	|| this.subtitle;
			this.fn = this.fn		|| this.subtitle;
			this.ctrl = this.ctrl	|| this.subtitle;
			this.alt = this.alt || this.subtitle;
			this.cmd = this.cmd || this.subtitle;

			this.item_xml+="\n<item "+(this.uid?"uid=\""+this.uid+"\" ":"")+"valid=\""+this.valid+"\" "+(this.autocomplete?"autocomplete=\""+this.autocomplete+"\" ":"")+(this.type?"type=\""+this.type+"\"":"")+">";
			this.item_xml+="\n<title>"+this.title+"</title>";
			if(this.subtitle)this.item_xml+="\n<subtitle>"+this.subtitle+"</subtitle>";
			if(this.arg)	this.item_xml+="\n<arg>"+this.arg+"</arg>";
			if(this.icon)	this.item_xml+="\n<icon"+(this.icontype?" type=\""+this.icontype+"\"":"")+">"+this.icon+"</icon>";
			if(this.shift)	this.item_xml+="\n<subtitle mod=\"shift\">"+this.shift+"</subtitle>";
			if(this.fn)		this.item_xml+="\n<subtitle mod=\"fn\">"+this.fn+"</subtitle>";
			if(this.ctrl)	this.item_xml+="\n<subtitle mod=\"ctrl\">"+this.ctrl+"</subtitle>";
			if(this.alt)	this.item_xml+="\n<subtitle mod=\"alt\">"+this.alt+"</subtitle>";
			if(this.cmd)	this.item_xml+="\n<subtitle mod=\"cmd\">"+this.cmd+"</subtitle>";
			if(this.copy) 	this.item_xml+="\n<text type=\"copy\">"+this.copy+"</text>";
			if(this.largetype) this.item_xml+="\n<text type=\"largetype\">"+this.largetype+"</text>";
			this.item_xml+="\n</item>";

			return this.item_xml;
		}
	}

	this.add = function (title, index) {
		// create result
		var item = new this.result();
		item.title = title;
		if(index) item.indexed = true;

		// add it to list
		var new_order = this.results.push(item);

		// memorize required index
		if(index){
			if(!this.order[index]) this.order[index] = [];
			this.order[index].push(new_order-1);
		}

		// send it to work
		return this.results[new_order-1];
	}

	this.echo = function () {
		for (var i = 0, l = this.order.length; i < l; i++) {
			if(this.order[i]!=null){
				for (var j = 0; j < this.order[i].length; j++) {
					var result_xml = this.results[this.order[i][j]].toXML();
					this.xml += result_xml;
				};
			}
		};
		for (var i = 0, l = this.results.length; i < l; i++) {
			if(!this.results[i].indexed)
				this.xml += this.results[i].toXML();
		};

		var return_str = "<?xml version=\"1.0\"?><items>"+this.xml+"\n</items>";

		this.zero();

		return return_str;
	}

	this.zero = function () {
		this.xml = "";
		this.results = [];
		this.order = [];
	}
}


///////////////////////
//  POST-PROCESSING  //
///////////////////////

function exit_server () {
	console.log("server wants to exit. authorized? "+authorized_to_exit+", streaming? "+is_streaming);
	if(!is_streaming){
		authorized_to_exit = true;
		var parallel = new Parallel()
			.done(function () {
				if(authorized_to_exit){
					fs.unlink(node_pid, function (err) {
						console.log("definitively quiting");
						process.exit();
					});
				}
			})
			.add(kill_with_pid_file.bind(undefined, secondary_peerflix_pid))
			.add(post_processing)
	} else {
		timeout = setTimeout(exit_server, server_life);
	}
}

function post_processing (callback) {
	console.log("post processing");
	var parallel = new Parallel().done(callback || function(){});

	// refresh all favorite shows
	parallel.add(function (done) {
		if(!db.shows) db.shows = new Datastore({ filename: w.data+"/shows.db", autoload: true });
		db.shows.find({ fav: true }, function (err, docs) {
			if(docs && docs.length>0){
				for (var i = 0, l = docs.length; i < l; i++) {
					parallel.add((function (doc, done) {
						setTimeout(refresh_show(doc, done),i*1000)
					}).bind(undefined, docs[i]));
				};
			}
			done();
		});
	})


	// refresh top shows
	parallel.add(search_on_mdb.bind(undefined, "miscTopRatedTvs"));

	// add origin_country to db
	parallel.add(function (done) {
		db.shows.find({ country: { $exists: false } }, function (err, docs) {
			for (var i = docs.length - 1; i >= 0; i--) {
				parallel.add(function (done) {
					setTimeout((function (doc, done) {
						mdb.tvInfo({
						    id: doc.id
						}, (function(doc, err, res) {
							if(err) console.log(err);
						    if(res){
							    // update database with new data for the season
							    var setModifier = { $set: {} };
							    setModifier.$set["country"] = res.origin_country;
							    var str = "";
							    for (var i = 0; i < res.origin_country.length; i++) {
							    	str += (str.length>0?", ":"") + res.origin_country[i];
							    };
							    db.shows.update({
							    	id: parseInt(doc.id)
							    }, setModifier, {}, (function (str){
							    	console.log(" ... updated country "+str);
							    	done();
							    }).bind(undefined, (doc.name?doc.name:"")+" "+str));
							}

						}).bind(undefined, doc))
					}).bind(undefined, docs[i], done), 1000*i)
				})
			};
			done();
		});
	})

	// clean & optimize db
	parallel.add(function (done) {
		if(db.shows) db.shows.ensureIndex({ fieldName: 'id', unique: true }, function (err) {});
		if(db.queries_history) db.queries_history.ensureIndex({ fieldName: 'query', unique: true }, function (err) {});
		var db_keys = Object.keys(db);
		for (var i = db_keys.length - 1; i >= 0; i--) {
			console.log("compacting db "+db_keys[i]);
			db[db_keys[i]].persistence.compactDatafile;
		};
		done();
	})

	// dl & crop images
	clearInterval(delayed_images_interval);
	parallel.add(function (done) {
		db.shows.find({}, function (err, docs) {
			for (var i = docs.length - 1; i >= 0; i--) {
				parallel.add(dl_image.bind(undefined, imgs_folder+"/"+docs[i].id, docs[i].poster_path));
			};
			done();
		});
	})

	// remove old episode video files
	parallel.add(function (done) {
		fs.readdir(episodes_folder, function(err, files) {
		    if (!err) {
		        for (var i = files.length - 1; i >= 0; i--) {
		        	parallel.add((function (file, done) {
			            fs.stat(file, (function(file, err, stats) {
			            	var file_age = (Date.now() - new Date(stats.atime).getTime()) / (1000 * 60 * 60);
			            	if (file_age>keep_video_files_for) {
			            		console.log("deleting "+file);
			            		parallel.add(fs.removeRecursive.bind(undefined, file));
			            	}
			            	done();
			            }).bind(undefined, file));
			        }).bind(undefined, episodes_folder + "/" + files[i]));
		        };
		    }
		    done();
		})
	})
}

fs.removeRecursive = function(path, callback) {
    var self = this;
    fs.stat(path, function(err, stats) {
        if (err) {
            callback(err, stats);
            return;
        }
        if (stats.isFile()) {
            fs.unlink(path, function(err) {
                if (err) {
                    callback(err, null);
                } else {
                    callback(null, true);
                }
                return;
            });
        } else if (stats.isDirectory()) {
            fs.readdir(path, function(err, files) {
                if (err) {
                    callback(err, null);
                    return;
                }
                var f_length = files.length;
                var f_delete_index = 0;
                var checkStatus = function() {
                    if (f_length === f_delete_index) {
                        fs.rmdir(path, function(err) {
                            if (err) {
                                callback(err, null);
                            } else {
                                callback(null, true);
                            }
                        });
                        return true;
                    }
                    return false;
                };
                if (!checkStatus()) {
                    for (var i = 0; i < f_length; i++) {
                        (function() {
                            var filePath = path + '/' + files[i];
                            fs.removeRecursive(filePath, function removeRecursiveCB(err, status) {
                                if (!err) {
                                    f_delete_index++;
                                    checkStatus();
                                } else {
                                    callback(err, null);
                                    return;
                                }
                            });
                        })()
                    }
                }
            });
        }
    });
};

function refresh_show(show, callback){
	get_seasons(show, function (show) {
		get_episodes(show, find_latest(show.season).season_number, function (show) {
			get_magnets_for_season(show, find_latest(show.season).season_number, function (show) {
				find_ep_to_watch(show, function (episode, show) {
					var parallel = new Parallel().done(callback)
						.add(function (done) {
							get_episode_after_episode(show, episode, (function (done, episode, show) {
								get_magnet(show, episode, done);
							}).bind(undefined, done))
						})
						.add(get_magnet.bind(undefined, show, episode));
				});
			});
		});
	});
}

function dl_image (img_name, url, callback) {
	var parallel = new Parallel().done(callback || function(){}).add(function (done) {
		fs.exists(img_name+".jpg", (function  (img_name, url, exists) {
			if (!exists) {
				console.log("processing image "+img_name)
				if(!exec) exec = require('child_process').exec;
				request("https://image.tmdb.org/t/p/w300"+url).pipe(fs.createWriteStream(img_name+"-nocrop.jpg")).on('close', (function (img_name) {
					// crop all images to alfred format
					img_name = img_name.replace(/ /g, "\\ ");
					exec("(sips -c 256 256 "+img_name+"-nocrop.jpg;mv "+img_name+"-nocrop.jpg "+img_name+".jpg)", function(error, stdout, stderr){
						if(error) console.log("error:"+error+"\nstdout:"+stdout+"\nstderr:"+stderr);
						done();
					});
				}).bind(undefined, img_name));
			} else {
				done();
			}
		}).bind(undefined, img_name, url));
	})
}


///////////////////////
//  FAVORITE TOGGLE  //
///////////////////////

function toggle_fav (id, bool) {
	if(!db.shows) db.shows = new Datastore({ filename: w.data+"/shows.db", autoload: true });
	var fav = (bool==1||bool==true);
	db.shows.update({ id: parseInt(id) }, { $set: { fav: fav } }, {}, (function (err, numReplaced) {
		console.log(fav?"added to favorites":"removed from favorites")
	}).bind(undefined, fav));
}


///////////////////////////
//  RESPOND WITH MAGNET  //
///////////////////////////

function respond_with_next_magnet (id, season, episode, callback) {
	if(!db.shows) db.shows = new Datastore({ filename: w.data+"/shows.db", autoload: true });
	db.shows.findOne({id: parseInt(id)}, (function (callback, season, episode, err, show) {
		if(!show){
			console.log("no show");
			callback(false);
		} else get_specific_episode(show, parseInt(season), parseInt(episode), (function (callback, episode, show) {
			if(!episode){
				console.log("no episode")
				callback(false);
			} else get_episode_after_episode(show, episode, (function (callback, episode, show) {
				if(!episode){
					console.log("no episode after")
					callback(false);
				} else get_best_magnet(show, episode, (function (callback, show, episode, magnet) {
					if(!magnet) callback(false)
					else callback(show.id+" "+episode.season_number+" "+episode.episode_number+" "+magnet)
				}).bind(undefined, callback, show, episode))
			}).bind(undefined, callback))
		}).bind(undefined, callback))
	}).bind(undefined, callback, season, episode));
}

function respond_with_magnet (id, season, episode, callback){
	if(!db.shows) db.shows = new Datastore({ filename: w.data+"/shows.db", autoload: true });
	db.shows.findOne({id: parseInt(id)}, (function (callback, season, episode, err, show) {
		if(!show){
			console.log("no show");
			callback(false);
		} else get_specific_episode(show, parseInt(season), parseInt(episode), (function (callback, episode, show) {
			if(!episode){
				console.log("no episode")
				callback(false);
			} else get_best_magnet (show, episode, callback)
		}).bind(undefined, callback))
	}).bind(undefined, callback, season, episode));
}

function get_best_magnet (show, episode, callback) {
	get_magnet(show, episode, (function (callback, show, episode, magnet) {
		search_piratebay(show.name+" "+episode.season_number+"x"+leading_zero(episode.episode_number), (function (callback, show, episode, results) {

			if(results && results.length>0){
				var regexed_name = show.name.replace(/[^a-zA-Z0-9 ]/g, '.?')
				regexed_name = regexed_name.replace(/[ ]/g, "[. ]?");
				var re = new RegExp(regexed_name+"[. ]?"+episode.season_number+"x"+leading_zero(episode.episode_number), "i");

				var found = false;
				for (var i = 0, l = results.length; i < l; i++) {
					var match = results[i].name.match(re);
					if(match && match.length>0){
						found = true;
						break;
					}
				};

				if(found && ((!magnet || !magnet.piratebay) || results[i].seeders > magnet.piratebay.seeders)){
					magnet = {
						"timestamp": Date.now(),
						"piratebay": results[i]
					}
					console.log("found good SxEE magnet");
				}
			}

			if(!magnet || !magnet.piratebay){
				console.log("no magnet")
				callback(false);
			} else {
				console.log("sending magnet "+magnet.piratebay.name);
				callback(magnet.piratebay.magnetLink);
			}

		}).bind(undefined, callback, show, episode))
	}).bind(undefined, callback, show, episode))
}


///////////////////////
//  MARK AS WATCHED  //
///////////////////////

function mark_as_watched (id, season, episode) {
	if(!db.shows) db.shows = new Datastore({ filename: w.data+"/shows.db", autoload: true });

	if(season && episode){
		db.shows.update(
			{ id: parseInt(id) },
			{ $set:
				{ last_watched: {
					"season": parseInt(season),
					"episode": parseInt(episode),
					"timestamp": Date.now()
				} }
			}, {}, function () {
				console.log("marked "+id+" as watched");
			}
		);
	} else {
		db.shows.findOne({id: parseInt(id)}, function (err, show) {
			if(show){
				find_latest_episode_of_show(show, function (latest_episode, show) {
					if(latest_episode && latest_episode.season_number && latest_episode.episode_number){
						db.shows.update(
							{ id: show.id },
							{ $set:
								{ last_watched: {
									"season": parseInt(latest_episode.season_number),
									"episode": parseInt(latest_episode.episode_number),
									"timestamp": Date.now()
								} }
							}, {}, (function (show) {
								console.log("marked "+show.id+" ("+show.name+") as watched");
							}).bind(undefined, show)
						);
					}
				})
			}
		});
	}
}


///////////////////////
//  STREAMING LOGIC  //
///////////////////////

function handle_stream (info, id, player){
	post_process_while_streaming = setTimeout(post_processing, delay_before_post_process);
	is_streaming = true;

	// parse info
	stream_summary = {};
	stream_summary.has_started = false;
	stream_summary.title = info.split('\n')[0];
	stream_summary.step = false;
	stream_summary.showId = id;
	stream_summary.showName = info.split(', s');
	stream_summary.season = stream_summary.showName[1].split('e');
	stream_summary.episode = parseInt(stream_summary.season[1].split(':')[0]);
	stream_summary.season = parseInt(stream_summary.season[0]);
	stream_summary.showName = stream_summary.showName[0].trim();
	stream_summary.monitorCounter = 0;
	stream_summary.logged_end = false;
	stream_summary.logged_start = false;
	fs.readFile(peerflix_pid, 'utf8', function (err, data) {
		stream_summary.peerflix_pid = data;
	});
	console.log("streaming: "+stream_summary.showName+" s"+stream_summary.season+" e"+stream_summary.episode+", show id:"+id);

	if(player=="mpv"){
		monitor_mpv();
	} else {
		player_monitoring = setInterval(monitor_vlc, 1000);
	}
}

function monitor_mpv (){
	if(stream_summary.reopen == undefined) stream_summary.reopen = true;
	if(stream_summary.can_log == undefined) stream_summary.can_log = true;

	if(!socket){
		socket = require('net').Socket();
		socket.on("connect", function() {
			socket.write('{ "command": ["observe_property", 1, "time-pos"] }\n{ "command": ["observe_property", 2, "length"] }\n');
		});

		socket.on("data", function(data) {
			stream_summary.has_started = true;
			stream_summary.reopen = false;
			var data = data.toString('ascii').trim().split("\n");
			for (var i = 0; i < data.length; i++) {
				var msg = JSON.parse(data[i]);
				if(msg.event){
					switch(msg.event){
						case 'property-change':
								if(stream_summary.can_log) switch(msg.name){
									case 'length':
										stream_summary.duration = msg.data;
										break;
									case 'time-pos':
										stream_summary.progress = msg.data;
										if(stream_summary.can_log && !stream_summary.logged_end && stream_summary.duration && stream_summary.progress && stream_summary.progress/stream_summary.duration > percent_to_consider_watched+.01){
											log_show_progress(stream_summary)
											stream_summary.logged_end = true;
										}
										if(stream_summary.can_log && !stream_summary.logged_start && stream_summary.duration && stream_summary.progress){
											log_show_progress(stream_summary)
											stream_summary.logged_start = true;
										}
										break;
									default:
										break;
								}
							break;
						case 'pause':
							if(stream_summary.can_log) log_show_progress(stream_summary);
							break;
						case 'seek':
							if(stream_summary.can_log) log_show_progress(stream_summary);
							break;
						case 'end-file':
							stream_summary.can_log = false;
							break;
						default:
							console.log(msg.event);
							break;
					}
				}
			};

		});

		socket.on("error", function (err) {
			console.log(err);
			stream_summary.reopen = (!stream_summary.has_started && err.toString('ascii').trim() == "Error: connect ECONNREFUSED")
		});

		socket.on('close', function () {
			if(stream_summary.reopen)
				setTimeout(monitor_mpv, 1000);
			else{
				stream_summary.reopen = true;
				delete stream_summary.can_log;
				finish_streaming();
			}
		});
	}

	socket.connect("socket.io");
}

function monitor_vlc (){
	if(!Netcat) Netcat = require('node-netcat');
	var client = Netcat.client(vlc_tcp[1], vlc_tcp[0]);
	var full_data = "";
	var get_length = (stream_summary.progress && !stream_summary.duration);

	client.on('open', function () {
		if(stream_summary.step)
			client.send('get_title'+'\n', true);
		else
			client.send((get_length?'get_length':'get_time')+'\n', true);
	});

	client.on('data', function (data) {
		full_data += data.toString('ascii');
	});

	client.on('error', function (err) {
		if(err=="Error: connect ECONNREFUSED" && stream_summary.has_started)
			finish_streaming();
		else
			console.log("err: "+err);
	});

	client.on('close', function () {
		if(stream_summary.step){
			var data_line = full_data.split('\n')[2];
			if(data_line == "> "+stream_summary.title){
				if(stream_summary.temp_result && stream_summary.temp_request){
					stream_summary[stream_summary.temp_request] = stream_summary.temp_result;
					if(!stream_summary.logged_end && stream_summary.duration && stream_summary.progress && stream_summary.progress/stream_summary.duration > percent_to_consider_watched+.01){
						log_show_progress(stream_summary)
						stream_summary.logged_end = true;
					}
					if(!stream_summary.logged_start && stream_summary.duration && stream_summary.progress){
						log_show_progress(stream_summary)
						stream_summary.logged_start = true;
					}
				}
			} else if(data_line && (simplify_str(data_line) == simplify_str("> http://127.0.0.1:8375/")) && !stream_summary.duration){
				console.log("title not there yet")
				stream_summary.has_started = false;
				stream_summary.step = false;
			} else if(stream_summary.has_started){
				console.log("no no no no no title changed");
				finish_streaming();
			} else {
				stream_summary.has_started = false;
				stream_summary.step = false;
			}
			stream_summary.temp_result = false;
			stream_summary.temp_request = false;
		} else {
			var number = full_data.match(/[0-9]+$/m);
			if(number){
				if(get_length){
					stream_summary.temp_result = number[0];
					stream_summary.temp_request = "duration"
				}
				else{
					if(!stream_summary.progress) console.log("Playback started, tracking progress for "+stream_summary.showName+" s"+stream_summary.season+" e"+stream_summary.episode);
					if(number[0]>0){
						stream_summary.temp_result = number[0];
						stream_summary.temp_request = "progress"
					}
				}
				stream_summary.has_started = true;
			}
		}

		// increment step
		if(stream_summary.has_started){
			stream_summary.step = !stream_summary.step;
		}
	});

	client.start();
}

function escapeRegExp(str) {
	return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
}

function finish_streaming (){
	stream_summary.has_started = false;
	if(player_monitoring) clearInterval(player_monitoring);
	is_streaming = false;

	// kill sub processes and remove pid files
	kill_with_pid(stream_summary.peerflix_pid)

	//check that we have all the data we need and log it to db
	log_show_progress(stream_summary)

	console.log("finished streaming");
}

function log_show_progress (stream_summary) {
	if(stream_summary.showId && stream_summary.season && stream_summary.episode){
		var setModifier = { $set: {} };

		setModifier.$set["last_watched.timestamp"] = Date.now();
		setModifier.$set["last_watched.season"] = stream_summary.season;
		setModifier.$set["last_watched.episode"] = stream_summary.episode;
		clean_watch_log_after(stream_summary.showId, stream_summary.season, stream_summary.episode);

		if(stream_summary.progress && stream_summary.duration){
			setModifier.$set["last_watched.progress"] = stream_summary.progress;
			setModifier.$set["last_watched.duration"] = stream_summary.duration;
			setModifier.$set["season."+stream_summary.season+".episode."+stream_summary.episode+".duration"] = stream_summary.duration;
			setModifier.$set["season."+stream_summary.season+".episode."+stream_summary.episode+".progress"] = stream_summary.progress;
		}

		db.shows.update({
			id: parseInt(stream_summary.showId)
		}, setModifier, {}, (function (stream_summary, err, numReplaced, newDoc){
			console.log("logging "+stream_summary.showName+" at "+Math.round(100*stream_summary.progress/stream_summary.duration)+"%");
			db.shows.findOne({id: parseInt(stream_summary.showId)}, function (err, doc) {
				if(doc){
					find_ep_to_watch(doc, function (episode, show) {
						if(episode)
							get_magnet(show, episode, function(){});
					});
				}
			});
		}).bind(undefined, stream_summary));
	}
}

function clean_watch_log_after (show_id, season_number, episode_number) {
	db.shows.findOne({ id: parseInt(show_id) }, (function (season_number, episode_number, err, doc) {
		if(doc){
			var setModifier = { $unset: {} };
			var season_keys = Object.keys(doc.season);
			for (var i = 0, l = season_keys.length; i < l; i++) {
				if(parseInt(season_keys[i])>=season_number){
					if(doc.season[""+season_keys[i]+""].episode){
						var episode_keys = Object.keys(doc.season[""+season_keys[i]+""].episode);
						for (var j = 0, m = episode_keys.length; j < m; j++) {
							if((parseInt(season_keys[i])==season_number && parseInt(episode_keys[j])>episode_number) || parseInt(season_keys[i])>season_number){
								setModifier.$unset["season."+season_keys[i]+".episode."+episode_keys[j]+".duration"] = true;
								setModifier.$unset["season."+season_keys[i]+".episode."+episode_keys[j]+".progress"] = true;
							}
						};
					}
				}
			}
			db.shows.update({
				id: parseInt(doc.id)
			}, setModifier, {}, function(){});
		}
	}).bind(undefined, season_number, episode_number));
}

function kill_with_pid_file(pid_file, callback){
	fs.readFile(pid_file, 'utf8', (function (pid_file, callback, err, data) {
		if(err) return callback();
		data=data.split(" ",1);
		kill_with_pid(data, (function (pid_file, callback) {
			fs.unlink(pid_file, callback);
		}).bind(undefined, pid_file, callback));
	}).bind(undefined, pid_file, callback));
}

function kill_with_pid(pid, callback) {
	try {
		process.kill(pid, 'SIGINT');
		console.log("... killed "+pid);
	} catch(e){
		console.log("... "+pid+" was dead already");
	}
	if(callback) callback();
}


///////////////////////////////////////
//  COLLECTING ANONYMOUS USAGE DATA  //
///////////////////////////////////////
setTimeout(anonymous, 30000);
var anonymous_id = w.data+"/id";
var anonymous_shows = "";
var sent_once = false;
function anonymous () {
	fs.exists(anonymous_id, function (exist) {
		if (exist){
			fs.readFile(anonymous_id, 'utf8', function (err, data) {
				send_anonymous(data);
			})
		} else
			write_anonymous_id();
	})
}
function send_anonymous(guid) {
	if(anonymous_shows.length!=0 || !sent_once){
		if(!request) request = require('request');
		request("http://alfred.florianpellet.com/show/show_ping.php?guid="+guid+"&shows="+encodeURI(anonymous_shows), function () {});
	}
	setTimeout(anonymous, 30000);
	sent_once = true;
	anonymous_shows = "";
}
function write_anonymous_id () {
	var guid = ""+Date.now()+(process.env.HOME.split("/").pop());
	fs.writeFile(anonymous_id, guid);
	send_anonymous(guid);
}
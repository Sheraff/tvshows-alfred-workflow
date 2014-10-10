var weird_block1 = 0;
/*
 * TODO:
 * read user prefs from file?
 * remove old db entries in post-processing
 * fetch latest episodes for watched shows in post-processing
 * query piratebay as early as possible (if the user is almost up to date, the desired episode is probably on the search page without specifying sXXeXX)
 * switch to `sips` for image croping: sips -c 60 60 imagename.jpg
 * better no-result case
 * use "season" torrents if nothing else available
 * handle cases where there is no internet / results from mdb or piratebay are unavailable
 * add timeout on all LOCAL AND MOVIE DATABASE RELATED functions
 * if VLC stops playing for a while, log progress
 *
 */

///////////////
// VARIABLES //
///////////////

var DEBUG = false;
var DEBUG_QUERY = "Attack on Titan";

// essential modules
var http = require('http');
var qs = require('querystring');
var Datastore = require('nedb');
var fs = require('fs');

// delayed modules
var mdb;
var cheerio;
var request;
var easyimg;
var Netcat;
var exec;

// server
var host = process.argv[2]?process.argv[2].split(':'):['127.0.0.1','8374'];
var server_life = DEBUG?5000:60000;
var http_response;

// user prefs
var mdb_API_key = "26607a596b2ac49958a20ec3ab295259";
var percent_to_consider_watched = .85;

// alfred
var w = new alfred_xml("florian.shows");
var node_pid = w.cache+"/node.pid";
var imgs_folder = w.cache+"/imgs";
var db_folder = w.cache+"/dbs";
var summaries_folder = w.cache+"/summaries";

// streaming
var peerflix_pid = w.cache+"/peerflix.pid";
var vlc_pid = w.cache+"/vlc.pid";
var is_streaming = false;
var delay_before_post_process = 120000;
var vlc_tcp = ['127.0.0.1','8376'];
var post_process_while_streaming, vlc_monitoring;
var stream_summary = {};

// globals
var db = {};
var timeout = setTimeout(exit_server, server_life);
var exitInterval;
var dontLeave = 0;
var countDownToEcho = 0;
var delayed_images = [];
var delayed_images_interval;


//////////////
//  SERVER  //
//////////////

http.createServer(function (req, res) {
	if(timeout) clearTimeout(timeout);
	if(exitInterval) clearInterval(exitInterval);
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

			if(post['stream'])
				handle_stream(post['stream'], post['show_id']);

			else if(post['fav'])
				toggle_fav(post['fav'], post['bool'], true);

			else
				use_query(post['query']);

			if(is_streaming)
				post_process_while_streaming = setTimeout(post_processing, delay_before_post_process);
		});
	} else {
		http_response.end('pong');
	}

	timeout = setTimeout(exit_server, server_life);
}).listen(host[1], host[0]);
initialize();
if(DEBUG) {
	finish_loading();
	search_for_show(DEBUG_QUERY);
}

function initialize () {
	//things to do right away
	if(!fs.existsSync(db_folder)) fs.mkdirSync(db_folder);

	//things that can wait a second
	setTimeout(function () {
		if(!db.queries_history) db.queries_history = new Datastore({ filename: db_folder+"/queries_history.db", autoload: true });
		if(!db.shows) db.shows = new Datastore({ filename: db_folder+"/shows.db", autoload: true });
		if(!cheerio) cheerio = require('cheerio');
		if(!mdb) mdb = require('moviedb')(mdb_API_key);
		if(!request) request = require('request');
		if(!exec) exec = require('child_process').exec;
		if(!fs.existsSync(summaries_folder)) fs.mkdirSync(summaries_folder);
		if(!fs.existsSync(imgs_folder)) fs.mkdirSync(imgs_folder);
		delayed_images_interval = setInterval(function () {
			for (var i = Math.min(5, delayed_images.length); i > 0; i--) {
				var img = delayed_images.shift();
				dl_image(imgs_folder+"/"+img.id, img.path);
			};
		}, 2000);
	}, 2000);
}


///////////////////////
//  INTERFACE LOGIC  //
///////////////////////

function use_query (query) {
	console.log("use_query: "+query);
	query = query.trim();
	if(query && query!="miscTopRatedTvs")
		search_for_show(query)
	else
		homepage()
}

function homepage() {
	console.log("homepage");
	//echo favs with ordering: output + simple info
	if(!db.shows) db.shows = new Datastore({ filename: db_folder+"/shows.db", autoload: true });
	one_more_thing_to_do();
	db.shows.find({ fav: true }, function (err, docs) {
		if(docs){
			for (var i = 0, l = docs.length; i < l; i++) {
				one_more_thing_to_do();
				complete_oneline_output(docs[i], one_more_thing_to_do, try_to_output);
			};
		}

		//echo misctv: simple output
		one_more_thing_to_do();
		search_on_mdb("miscTopRatedTvs", function (results) {
			for (var i = 0, l = results.length; i < l; i++) {
				if(good_enough_show(results[i]) && (!docs || !is_doc_in_docs(results[i].id, docs))){
					one_more_thing_to_do();
					simple_output(results[i], try_to_output);
				}
			}
			try_to_output();
		});

		try_to_output();
	})
}

function search_for_show (query) {
	console.log("search_for_show");

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

	//search_on_mdb
	search_on_mdb (query, (function (corrected_query, season, episode, query, results) {

		if(!results || results.length==0)
			no_result();

		// is query a match for a show (exact match or only one result)
		var only_one_good_show = false, good_shows_count = 0, exact_match = false;
		for (var i = results.length - 1; i >= 0; i--) {
			if(good_enough_show(results[i])){
				if(query==results[i].name){
					exact_match = results[i];
				}
				only_one_good_show = results[i];
				good_shows_count++;
			}
		};
		if(good_shows_count==0)
			no_result();
		else if(good_shows_count>1 || (only_one_good_show && simplify_str(query)!=simplify_str(only_one_good_show.name))) only_one_good_show = false;


		//single result: complete info
		if(only_one_good_show || exact_match ){
			if(corrected_query)
				browse(only_one_good_show || exact_match, season, episode, one_more_thing_to_do, try_to_output);
			else
				complete_output(only_one_good_show || exact_match, one_more_thing_to_do, try_to_output);
		}

		//multiple results: simple output
		else {
			for (var i = 0, l = results.length; i < l; i++) {
				if(good_enough_show(results[i])){
					one_more_thing_to_do();
					simple_output(results[i], try_to_output);
				}
			}
		}
	}).bind(undefined, corrected_query, season, episode, query))
}

function no_result(){
	w.add("No result.");
	try_to_output();
}

function simple_output(result, callback) {
	console.log("simple_output");
		var item = w.add(result.name);
		item.autocomplete = result.name;
		item.valid = "NO";
		// item.subtitle = rating_in_stars(result.vote_average); // +" — "+result.name+(result.first_air_date?" ("+(result.first_air_date.split("-")[0])+")":"");
		fs.exists(imgs_folder+"/"+result.id+".jpg", (function (callback, item, name, exists) {
			item.icon = exists?name:"icon.png";
			callback();
		}).bind(undefined, callback, item, imgs_folder+"/"+result.id+".jpg"));
}

function complete_oneline_output (result, callup, calldown) {
	console.log("complete_oneline_output");
	//add result
	var item = w.add(result.name, w.results.length+1);
	item.subtitle = "♥ ";
	item.autocomplete = result.name;
	item.valid = "NO";
	item.uid = "result.name";
	callup();
	fs.exists(imgs_folder+"/"+result.id+".jpg", (function (callback, item, name, exists) {
		item.icon = exists?name:"icon.png";
		callback();
	}).bind(undefined, calldown, item, imgs_folder+"/"+result.id+".jpg"));

	//look for extra things to display
	db.shows.findOne({ id: result.id }, (function (callback, item, err, doc) {
		if(doc) find_ep_to_watch(doc, (function (callback, item, doc, episode) {
			if(episode){
				if(episode.progress){
					item.subtitle += Math.round(100*episode.progress/episode.duration)+"% of "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" );
				} else if(doc.status && doc.status=="Ended") {
					item.subtitle += "Ended";
				} else if(doc.last_watched) {
					item.subtitle += "Next up: "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" );
				} else {
					item.subtitle += "Latest episode: "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" );
				}
				callback();
			} else {
				find_next_release(doc, (function (callback, item, doc, episode) {
					if(episode){
						var first = ( episode.season_number == 1 && episode.episode_number == 1 ? "First" : "Next" );
						var date = episode.air_date?parse_date(episode.air_date):false;
						if(date) item.subtitle += first+" episode"+date
					} else if(doc.status && doc.status=="Ended") {
						item.subtitle += "Ended";
					} else {
						item.subtitle += "Next episode's date not set yet";
					}
					callback();
				}).bind(undefined, callback, item, doc));
			}
		}).bind(undefined, callback, item, doc))
		else callback();
	}).bind(undefined, calldown, item));
}

function browse (result, season, episode, callup, calldown) {
	console.log("browse");
	if(season) season = parseInt(season);
	if(episode) episode = parseInt(episode);
	if(!db.shows) db.shows = new Datastore({ filename: db_folder+"/shows.db", autoload: true });
	db.shows.findOne({ id: result.id }, (function (callup, calldown, result, season, episode, err, doc) {
		if(doc){
			browse2(doc, season, episode, callup, calldown)
		} else {
			detail_show(result, (function (season, episode, callup, calldown, doc) {
				browse2(doc, season, episode, callup, calldown)
			}).bind(undefined, season, episode, callup, calldown));
		}
	}).bind(undefined, callup, calldown, result, season, episode));
}

function browse2 (doc, season_number, episode_number, callup, calldown) {
	season_number = parseInt(season_number)
	episode_number = parseInt(episode_number)
	if(episode_number){
		get_specific_episode(doc, season_number, episode_number, (function (calldown, episode, show) {
			if(episode.episode_number && episode.episode_number != 0){
				var item = w.add(( episode.name && pretty_string(episode.name) ) ? episode.name : show.name+" "+formatted_episode_number(episode));
				if(episode.air_date && date_from_tmdb_format(episode.air_date)>Date.now())
					item.subtitle = "Will air "+pretty_date(episode.air_date)
				else if(episode.magnet && episode.magnet.piratebay){
					if(episode.progress && percent_progress(episode)<percent_to_consider_watched*100){
						item.subtitle = "Resume watching at "+percent_progress(episode)+"% ( ⌘+Enter to watch from the beginning, ⌥+Enter to download torrent )";
						item.cmd = "Watch from the beginning ( release ⌘ to resume streaming at "+percent_progress(episode)+"%, ⌥+Enter to download torrent )";
					} else {
						item.subtitle = "Start streaming this episode ( ⌥+Enter to download torrent )";
					}
					item.alt = "Download torrent ( release ⌥ to "+(episode.progress && episode.progress>30?"resume streaming at "+percent_progress(episode)+"%, ⌘+Enter to watch from the beginning":"start streaming this episode")+" )";
					item.arg = "m"+show.id+" "+(episode.progress || 0)+" "+episode.magnet.piratebay.magnetLink+" "+show.name+", "+formatted_episode_number(episode)+": "+episode.name;
				} else {
					if(episode.air_date && date_from_tmdb_format(episode.air_date) > Date.now()-25*60*60*1000)
						item.subtitle = "This episode just came out, give it a few hours and it'll be available...";
					else if(episode.progress && percent_progress(episode)<percent_to_consider_watched*100)
						item.subtitle = "You watched "+percent_progress(episode)+"% of this episode, but it isn't available on piratebay anymore. Press Enter to mark as watched."
					else
						item.subtitle = "Not available on piratebay";
					item.valid = "NO";
				}
			} else
				no_result();
				calldown();
		}).bind(undefined, calldown));
	} else if(season_number && season_number != 0){
		get_episodes(doc, season_number, (function (calldown, season_number, show) {
			if(show.season[""+season_number+""] && show.season[""+season_number+""].episode){
				var keys = Object.keys(show.season[""+season_number+""].episode).sort(function (a, b) {
					a=parseInt(a);
					b=parseInt(b);
					return (a>b?-1:a<b?1:0);
				})
				for (var i = 0, l = keys.length; i < l; i++) {
					if(parseInt(keys[i])!=0){
						var episode = show.season[""+season_number+""].episode[""+keys[i]+""];
						var item = w.add(episode.episode_number+" - "+(pretty_string(episode.name) ? episode.name : "Episode "+episode.episode_number), i+1);
						item.autocomplete = show.name + " s" + leading_zero(season_number) + "e" + leading_zero(show.season[""+season_number+""].episode[""+keys[i]+""].episode_number);
						item.valid = "NO";
						if(show.last_watched && show.last_watched.season == season_number && show.last_watched.episode == episode.episode_number){
							item.subtitle = "This is the last episode you watched. You stopped at "+percent_progress(episode)+"%.";
						}
						if(date_from_tmdb_format(episode.air_date)>Date.now()){
							item.subtitle = "Will air "+pretty_date(episode.air_date)+".";
						}
					}
				};
				get_magnets_for_season(show, season_number, function () {});
			} else
				no_result();
				calldown();
		}).bind(undefined, calldown, season_number));
	} else {
		get_seasons(doc, (function (calldown, show) {
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
			calldown();
		}).bind(undefined, calldown));
	}
}

function complete_output (result, callup, calldown) {
	console.log("complete_output");
	//this might take some time notification
	console.log("notif: "+(result.name || "New TV show")+" "+result.id)
	if(!exec) exec = require('child_process').exec;
	exec("/usr/bin/terminal-notifier -title \""+(result.name || "New TV show")+"\" -message \"Fetching data, just a sec...\" -sender com.runningwithcrayons.Alfred-2"+(result.id?" -contentImage \""+imgs_folder+"/"+result.id+".jpg\"":""), function(){});
	if(!db.shows) db.shows = new Datastore({ filename: db_folder+"/shows.db", autoload: true });
	db.shows.findOne({ id: result.id }, (function (callup, calldown, result, err, doc) {
		if(doc){
			complete_output_2(doc, callup, calldown)
		} else {
			detail_show(result, (function (callup, calldown, doc) {
				complete_output_2 (doc, callup, calldown)
			}).bind(undefined, callup, calldown));
		}
	}).bind(undefined, callup, calldown, result));
}

function complete_output_2 (doc, callup, calldown){
	console.log("complete_output_2");
	//what to watch
	callup();
	find_ep_to_watch(doc, (function (callup, calldown, episode, doc) {
		var item = w.add("", 1)
		if(episode){
			//get magnet
			callup();
			get_magnet(doc, episode, (function (callback, episode, doc, magnet) {
				if(episode.progress && episode.progress>30){
					if(magnet.piratebay){
						item.title = "Resume watching "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" )
						item.subtitle = "You stopped at "+percent_progress(episode)+"% ( ⌘+Enter to watch from the beginning, ⌥+Enter to download torrent )";
						item.cmd = "Watch from the beginning ( release ⌘ to resume streaming at "+percent_progress(episode)+"%, ⌥+Enter to download torrent )";
					}
					else{
						item.title = "You stopped at % of "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" )
						item.subtitle = "but this episode isn't available on piratebay anymore. Press Enter to mark as watched."
					}
				} else {
					item.title = formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name) ) ? " — "+episode.name : "" );
					if(doc.last_watched)
						item.title = "Up next: "+item.title;
					else
						item.title = "Latest episode: "+item.title;
					if(magnet.piratebay){
						item.subtitle = "Start streaming this episode ( ⌥+Enter to download torrent )";
					} else {
						if(episode.air_date && date_from_tmdb_format(episode.air_date) > Date.now()-25*60*60*1000)
							item.subtitle = "This episode just came out, give it a few hours and it'll be available...";
						else
							item.subtitle = "Not available on piratebay";
						item.valid="NO";
					}
				}
				if(magnet.piratebay){
					item.arg = "m"+doc.id+" "+(episode.progress || 0)+" "+magnet.piratebay.magnetLink+" "+doc.name+", "+formatted_episode_number(episode)+": "+episode.name
					item.alt = "Download torrent ( release ⌥ to "+(episode.progress && episode.progress>30?"resume streaming at "+percent_progress(episode)+"%, ⌘+Enter to watch from the beginning":"start streaming this episode")+" )";
				}
				callback();
			}).bind(undefined, calldown, episode, doc))
		} else {
			if(show.status == "Ended"){
				item.title = "You have finished this show. Congratulation ;-)";
				item.subtitle = "Press Enter to mark as not watched";
			}
			else{
				item.title = "You are up to date with this show";
				if(doc.last_watched){
					item.subtitle = "up to s"+doc.last_watched.season+"e"+doc.last_watched.episode;
				} else {
					item.subtitle = "but this show hasn't ended yet"
				}
				item.valid="NO";
			}
		}

		//next out
		find_next_release(doc, (function (callback, episode, doc) {
			if(episode){
				var first = ( episode.season_number == 1 && episode.episode_number == 1 ? "First" : "Next" );
				var date = episode.air_date ? pretty_date(episode.air_date) : false;
				var subtitle = (date ? episode.air_date : "")+" — "+formatted_episode_number(episode)+( (episode.name && pretty_string(episode.name)) ? " — "+episode.name : "" );
				date = date ? " "+date : "'s air date not set yet";
				var item = w.add(first+" episode"+date, 2);
				item.subtitle = subtitle;
				item.valid="NO";
			} else {
				if(doc.status){
					var item = w.add("---", 2);
					item.valid="NO";
					if(doc.status != "Ended")
						item.subtitle = "Next episode's date not set yet";
					else
						item.subtitle = "This show has ended :-(";
				}
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

			//watch specific episode TODO
			var item = w.add("Browse all episodes", 5)
			item.subtitle = "Allows you to set where you're at in this show"
			item.valid = "NO"
			item.autocomplete = doc.name+" s"

			callback();
		}).bind(undefined, calldown));
	}).bind(undefined, callup, calldown));
}

function one_more_thing_to_do(n){
	countDownToEcho+=n||1;
}

function try_to_output(){
	countDownToEcho--;
	if(countDownToEcho<=0){
		countDownToEcho=0;
		console.log("try_to_output: passed");
		if(DEBUG)
			console.log(w.echo());
		else
			http_response.end(w.echo());
	}
}


///////////////////////
//  INTERFACE UTILS  //
///////////////////////

function good_enough_show (show) {
	return (show.name && show.first_air_date && show.first_air_date.split("-")[0]>1990 && show.popularity>0.008 && show.poster_path);
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
		case 1: return ""+nb+"st"; break
		case 2: return ""+nb+"nd"; break
		case 3: return ""+nb+"rd"; break
		default: return ""+nb+"th";
	}
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

function pretty_date (date) {
	var next_air_date = date.split("-");
	var now = new Date(Date.now());
	next_air_date = new Date(next_air_date[0], next_air_date[1]-1, next_air_date[2]);
	if(next_air_date.getTime()<now.getTime())
		return false;
	var next_ep_str = "";
	if(now.getFullYear()==next_air_date.getFullYear() && now.getMonth()==next_air_date.getMonth() && now.getDate()==next_air_date.getDate()){
		next_ep_str = "today";
	} else {
		var tomorrow = new Date(Date.now());
		tomorrow.setDate(tomorrow.getDate() + 1);
		if(tomorrow.getFullYear()==next_air_date.getFullYear() && tomorrow.getMonth()==next_air_date.getMonth() && tomorrow.getDate()==next_air_date.getDate()){
			next_ep_str = "tomorrow"
		} else {
			var next_week = new Date(Date.now());
			next_week.setDate(next_week.getDate() + 7);
			if(next_week.getTime()>next_air_date.getTime()){
				next_week.setDate(next_week.getDate() - 1);
				next_ep_str = next_air_date.getDate()==next_week.getDate() ? "next" : "on";
				next_ep_str += " "+(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][next_air_date.getDay()]);
			} else {
				if(now.getMonth()+1>=(next_air_date.getMonth())+12*(next_air_date.getFullYear()-now.getFullYear())){
					var in_days = Math.floor((next_air_date.getTime()-now.getTime())/(1000*60*60*24));
					if(in_days%7==0)
						next_ep_str = "in "+(in_days/7)+" weeks";
					else
						next_ep_str = "in "+in_days+" days";
				} else {
					next_ep_str = "in "+(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][next_air_date.getMonth()])
					if((now.getFullYear()+1==next_air_date.getFullYear() && now.getMonth()<=next_air_date.getMonth()) || now.getFullYear()+1<next_air_date.getFullYear()){
						next_ep_str += " "+next_air_date.getFullYear();
					}
				}
			}
		}
	}
	return next_ep_str;
}


////////////////////////////////////////
//  LOCAL AND MOVIE DATABASE RELATED  //
////////////////////////////////////////

function find_latest(array) {
	console.log("find_latest");
    var latest;
    var now = Date.now();
    for (var i = (array.isArray ? array.length : Object.keys(array).length) - 1; i >= 0; i--) {
        var index = array.isArray ? i : Object.keys(array)[i]
        //avoid season/episode 0 (usually "specials") being the main thing
        if (array[index].season_number == 0 || array[index].episode_number == 0) continue;
        //initialize with any
        if (!latest) {
            if (array[index].air_date && now > date_from_tmdb_format(array[index].air_date)) latest = array[index];
            continue;
        }
        //if "air_date" is defined for array[index] and is greater than that of latest (or latest's is undefined) but still smaller than Date.now()
        if (array[index].air_date && (!latest.air_date || array[index].air_date.localeCompare(latest.air_date) > 0) && now > date_from_tmdb_format(array[index].air_date)) latest = array[index];
    };
    return (latest && latest.air_date) ? latest : false;
}

function date_from_tmdb_format(tmdb_date) {
    var temp_date = tmdb_date.split("-");
    return new Date(temp_date[0], temp_date[1] - 1, temp_date[2])
}

function find_next_release (show, callback) {
	console.log("find_next_release");
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
	                                if(show.season[season_number].episode[1]) callback(show.season[season_number].episode[1], show)
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

function find_ep_to_watch(show, callback) {
	console.log("find_ep_to_watch");
    if (show.last_watched) {
    	console.log(1)
        if (show.last_watched.progress / show.last_watched.duration < percent_to_consider_watched) get_specific_episode(show, show.last_watched.season, show.last_watched.episode, callback)
        else get_specific_episode(show, show.last_watched.season, show.last_watched.episode + 1, (function(callback, episode) {
            if (episode) callback(episode, show)
            else get_specific_episode(show, show.last_watched.season + 1, 1, callback)
        }).bind(undefined, callback))
    } else {
    	console.log(2)
        get_seasons(show, (function(callback, show) {
            if (!show.season) callback(false, show)
            else {
            	console.log(3)
                var latest_season = find_latest(show.season)
                if (!latest_season) callback(false, show)
                else {
                	console.log(4)
                    get_episodes(show, latest_season.season_number, (function(callback, latest_season, show) {
                        if (!show.season[latest_season.season_number].episode) callback(false, show);
                        else callback(find_latest(show.season[latest_season.season_number].episode), show)
                    }).bind(undefined, callback, latest_season))
                }
            }
        }).bind(undefined, callback))
    }
}

function get_specific_season(show, season_number, callback) {
	console.log("get_specific_season");
    // everything taken care of for getting this season
    get_seasons(show, (function(callback, season_number, show) {
        if (show.season && show.season[season_number]) callback(show.season[season_number], show)
        else callback(false)
    }).bind(undefined, callback, season_number))
}

function get_seasons(show, callback) {
	console.log("get_seasons");
    // should i go fetch new data for the show?
    if (!show.season) detail_show(show, callback)
    else callback(show);
}

function detail_show(doc, callback) {
	console.log("detail_show");
    // fetch new data for the show
    mdb.tvInfo({
        id: doc.id
    }, (function(callback, doc, err, res) {
    	if(err) console.log(err);
        doc = update_doc_with_tvInfo(doc, res);
        callback(doc);
    }).bind(undefined, callback, doc))
}

function update_doc_with_seasonInfo(doc, res, season_number) {
	console.log("update_doc_with_seasonInfo");

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
    	if(res.episodes[i].episode_number!=0){
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
    return doc;
}

function get_specific_episode(show, season_number, episode_number, callback) {
	console.log("get_specific_episode");
    // everything taken care of for getting this season
    get_seasons(show, (function(callback, season_number, episode_number, show) {
        get_episodes(show, season_number, (function(callback, season_number, episode_number, show) {
            if (show.season && show.season[season_number] && show.season[season_number].episode && show.season[season_number].episode[episode_number]) callback(show.season[season_number].episode[episode_number], show)
            else callback(false)
        }).bind(undefined, callback, season_number, episode_number))
    }).bind(undefined, callback, season_number, episode_number))
}

function get_episodes(show, season_number, callback) {
	console.log("get_episodes");
    // should i go fetch new data for the season
    get_seasons(show, (function(callback, season_number, show) {
        if (show.season && show.season[season_number] && !show.season[season_number].episode) detail_season(season_number, show, callback)
        else callback(show);
    }).bind(undefined, callback, season_number))
}

function detail_season(season_number, doc, callback) { // TODO cache these queries to mdb like I cache the search queries
    // fetch new data for the season
    console.log("updating tvSeasonInfo for season " + season_number)
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
	console.log("update_doc_with_tvInfo");
    // updates the doc with new data for the season
    if (!doc) doc = {};
    doc["name"] = res.name;
    doc["id"] = parseInt(res.id);
    doc["poster_path"] = res.poster_path;
    doc["first_air_date"] = res.first_air_date;
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
    	if(res.seasons[i].season_number!=0){
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
    return doc;
}

function search_on_mdb (query, callback) {
	console.log("search_on_mdb")
	if(!db.queries_history) db.queries_history = new Datastore({ filename: db_folder+"/queries_history.db", autoload: true });
	db.queries_history.findOne({ query: query }, (function (callback, query, err, doc) {
		if(doc){
			callback(doc.results || false);
		} else {
			if(!mdb) mdb = require('moviedb')(mdb_API_key);
			mdb[(query=='miscTopRatedTvs'?'miscTopRatedTvs':'searchTv')]((query=='miscTopRatedTvs'?{}:{query: query, page: 1, search_type: "ngram"}), (function (callback, query, err, res) {
					callback(res.results || false);

					// store query
					db.queries_history.update({
						query: query
					}, {
						query: query,
						timestamp: Date.now(),
						results: res.results
					}, { upsert: true });

					// update shows with info contained in this query
					if(!db.shows) db.shows = new Datastore({ filename: db_folder+"/shows.db", autoload: true });
					for (var i = 0, l = res.results.length; i < l; i++) {
						if(good_enough_show(res.results[i])){
							db.shows.update({
								id: parseInt(res.results[i].id)
							}, { $set: {
								name: res.results[i].name,
								id: parseInt(res.results[i].id),
								poster_path: res.results[i].poster_path,
								first_air_date: res.results[i].first_air_date,
								vote_average: res.results[i].vote_average,
								popularity: res.results[i].popularity
							} }, { upsert: true });
						}
						if(res.results[i].poster_path) delayed_images.push({"id": parseInt(res.results[i].id), "path": res.results[i].poster_path});
					};



				}).bind(undefined, callback, query)
			);
		}
	}).bind(undefined, callback, query));
}

function get_magnet (show, episode, callback) {
	console.log("get_magnet");
	if(episode.magnet)
		callback(episode.magnet);
	else{
		search_piratebay(show.name+" "+formatted_episode_number(episode), (function (show, episode, callback, results) {
			var magnet = {
				"timestamp": Date.now(),
				"piratebay": (results.length>0?results[0]:false)
			}
			callback(magnet);

			var setModifier = { $set: {} };
			setModifier.$set["season."+episode.season_number+".episode."+episode.episode_number+".magnet"] = magnet;
			db.shows.update({
				id: parseInt(show.id)
			}, setModifier, { upsert: true }, function (){
				console.log(" ... new magnet "+(show.name?show.name:""));
			});

		}).bind(undefined, show, episode, callback));
	}
}

function get_magnets_for_season (show, season_number, callback) {
	get_episodes(show, season_number, (function (callback, season_number, show) {
		if(show.season && show.season[""+season_number+""] && show.season[""+season_number+""].episode){
			var keys = Object.keys(show.season[""+season_number+""]["episode"]);
			var has_em_all = true;
			for (var i = 0, l = keys.length; i < l; i++) {
				if(!show["season"][""+season_number+""]["episode"][keys[i]].magnet || show["season"][""+season_number+""]["episode"][keys[i]].magnet.piratebay==false){ // TODO check timestamp too
					has_em_all = false;
					break;
				}
			};
			if(has_em_all) callback(show);
			else {
				search_piratebay(show.name+" S"+leading_zero(season_number)+"E*", (function (callback, show, season_number, results) {
					//modify show
					var updated_episodes = [];
					var setModifier = { $set: {} };
					for (var i = 0, l = results.length; i < l; i++) {
						var match = results[i].name.match(/s[0-9]{2}e[0-9]{2}/i);
						if(match.length>0){
							var numbers = match[0].match(/[0-9]{2}/g)
							if(season_number==parseInt(numbers[0]) && updated_episodes.indexOf(parseInt(numbers[1]))==-1){
								var magnet = {
									"timestamp": Date.now(),
									"piratebay": results[i]
								}
								if(show["season"][""+season_number+""]["episode"][""+parseInt(numbers[1])+""]){
									show["season"][""+season_number+""]["episode"][""+parseInt(numbers[1])+""].magnet = magnet;
									setModifier.$set["season."+season_number+".episode."+parseInt(numbers[1])+".magnet"] = magnet;
									updated_episodes.push(parseInt(numbers[1]));
								}
							}
						}
					};

					callback(show)

					//log in db
					db.shows.update({
						id: parseInt(show.id)
					}, setModifier, { upsert: true }, function (){
						console.log(" ... updated all magnets for "+(show.name?show.name:"")+" season "+season_number);
					});
				}).bind(undefined, callback, show, season_number));
			}
		} else callback(false);
	}).bind(undefined, callback, season_number));
}


////////////////////////////////////////
//  DEAL WITH PIRATEBAY'S HTML INPUT  //
////////////////////////////////////////

function search_piratebay (query, callback) {
	if(!request) request = require('request');
	request({
			url: 'http://thepiratebay.se/search/'+query+'/0/7/205',
			gzip: 'true'
		}, (function (callback, error, response, body) {
			if (!error && response.statusCode == 200) {
				var results = crawl_piratebay_html(body);
				callback(results);
			}
		}).bind(undefined, callback)
	);
}

function crawl_piratebay_html (html) {
	if(!cheerio) cheerio = require('cheerio');
	var $ = cheerio.load(html),
	results = new Array();
	$('table#searchResult tr:has(a.detLink)').each(function(i, elem) {
		results.push({
			"name": $(this).find('a.detLink').text(),
			"uploadDate": $(this).find('font').text().match(/Uploaded\s(?:<b>)?(.+?)(?:<\/b>)?,/)[1],
			"size": $(this).find('font').text().match(/Size (.+?),/)[1],
			"seeders": $(this).find('td[align="right"]').first().text(),
			"leechers": $(this).find('td[align="right"]').next().text(),
			"link": $(this).find('div.detName a').attr('href'),
			"magnetLink": $(this).find('a[title="Download this torrent using magnet"]').attr('href'),
			// "category": {
			// 	"id": $(this).find('center a').first().attr('href').match(/\/browse\/(\d+)/)[1],
			// 	"name": $(this).find('center a').first().text(),
			// },
			// "subcategory": {
			// 	"id": $(this).find('center a').last().attr('href').match(/\/browse\/(\d+)/)[1],
			// 	"name": $(this).find('center a').last().text(),
			// }
		});
	});
	return results;
}


/////////////////////////////////////
//  DEAL WITH ALFRED'S XML OUTPUT  //
/////////////////////////////////////

function alfred_xml (bundleid) {
	this.cache = process.env.HOME + "/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow Data/" + bundleid;
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
			// this.shift = this.shift	|| this.subtitle;
			// this.fn = this.fn		|| this.subtitle;
			// this.ctrl = this.ctrl	|| this.subtitle;
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
		var a_result = new this.result();
		a_result.title = title;
		if(index) a_result.indexed = true;

		// add it to list
		var new_order = this.results.push(a_result);

		// memorize required index
		if(index) this.order[index] = new_order-1;

		// send it to work
		return this.results[new_order-1];
	}

	this.echo = function () {
		for (var i = 0, l = this.order.length; i < l; i++) {
			if(this.order[i]!=null){
				var result_xml = this.results[this.order[i]].toXML();
				this.xml += result_xml;
			}
		};
		for (var i = 0, l = this.results.length; i < l; i++) {
			if(!this.results[i].indexed)
				this.xml += this.results[i].toXML();
		};

		var return_str = "<?xml version=\"1.0\"?><items>"+this.xml+"\n</items>";

		this.xml = "";
		this.results = [];
		this.order = [];

		return return_str;
	}
}


///////////////////////
//  POST-PROCESSING  //
///////////////////////

function exit_server () {
	if(!is_streaming){
		post_processing();

		// exit (wait for all async processes to be done, stops trying if an http request comes in)
		exitInterval = setInterval(function () {
			if(dontLeave==0){
				console.log("bye bye");
				fs.unlink(node_pid);
				process.exit();
			}
		}, 5000);
	} else {
		timeout = setTimeout(exit_server, server_life);
	}
}

function post_processing () {
	console.log("post processing");
	// clean & optimize db
	db.shows.ensureIndex({ fieldName: 'id', unique: true }, function (err) {});
	db.queries_history.ensureIndex({ fieldName: 'query', unique: true }, function (err) {});
	for (var i = db.length - 1; i >= 0; i--) {
		db[i].persistence.compactDatafile;
	};

	// dl & crop images
	clearInterval(delayed_images_interval);
	db.shows.find({}, function (err, docs) {
		for (var i = docs.length - 1; i >= 0; i--) {
			dl_image(imgs_folder+"/"+docs[i].id, docs[i].poster_path);
		};
	});
}

function dl_image (img_name, url) {
	dontLeave++;
	fs.exists(img_name+".jpg", (function  (img_name, url, exists) {
		if (!exists) {
			if(!easyimg) easyimg = require('easyimage');
			request("https://image.tmdb.org/t/p/w60_or_h91"+url).pipe(fs.createWriteStream(img_name+"-nocrop.jpg")).on('close', (function (img_name) {
				// crop all images to alfred format
				easyimg.thumbnail({
					src:img_name+"-nocrop.jpg", dst:img_name+".jpg",
					width:60, height:60
				}).then(function(image) {
					fs.unlink(imgs_folder+"/"+image.name.replace(".jpg", "-nocrop.jpg"));
					dontLeave--;
				}, function (err) {
					console.log(err);
				});
			}).bind(undefined, img_name));
		} else {
			dontLeave--;
		}
	}).bind(undefined, img_name, url));
}


///////////////////////
//  FAVORITE TOGGLE  //
///////////////////////

function toggle_fav (id, bool, reply) {
	if(reply) http_response.end('ok');
	if(!db.shows) db.shows = new Datastore({ filename: db_folder+"/shows.db", autoload: true });
	var fav = (bool==1||bool==true);
	db.shows.update({ id: parseInt(id) }, { $set: { fav: fav } }, {}, (function (err, numReplaced) {
		console.log(fav?"added to favorites":"removed from favorites")
	}).bind(undefined, fav));
}


///////////////////////
//  STREAMING LOGIC  //
///////////////////////

function handle_stream (info, id){
	http_response.end('ok');
	is_streaming = true;

	// parse info
	stream_summary.showId = id;
	stream_summary.showName = info.split(', s');
	stream_summary.season = stream_summary.showName[1].split('e');
	stream_summary.episode = parseInt(stream_summary.season[1].split(':')[0]);
	stream_summary.season = parseInt(stream_summary.season[0]);
	stream_summary.showName = stream_summary.showName[0].trim();
	stream_summary.monitorCounter = 0;
	console.log("streaming: "+stream_summary.showName+" s"+stream_summary.season+" e"+stream_summary.episode+", show id:"+id);

	if(!Netcat) Netcat = require('node-netcat');
	vlc_monitoring = setInterval(monitor_vlc, 2000);
}

function monitor_vlc (){
	var client = Netcat.client(vlc_tcp[1], vlc_tcp[0]);
	var full_data = "";
	var get_length = (stream_summary.progress && !stream_summary.duration && stream_summary.monitorCounter>2);

	client.on('open', function () {
		client.send((get_length?'get_length':'get_time')+'\n', true);
	});

	client.on('data', function (data) {
		full_data += data.toString('ascii');
	});

	client.on('error', function (err) {
		if(err=="Error: connect ECONNREFUSED")
			finish_streaming();
		else
			console.log("err: "+err);
	});

	client.on('close', function () {
		var number = full_data.match(/[0-9]+$/m);
		if(number){
			if(get_length){
				console.log("duration: "+number[0]+"s ("+stream_summary.showName+" s"+stream_summary.season+" e"+stream_summary.episode+")");
				stream_summary.duration = number[0];
			}
			else{
				if(!stream_summary.progress) console.log("Playback started, tracking progress for "+stream_summary.showName+" s"+stream_summary.season+" e"+stream_summary.episode);
				else stream_summary.monitorCounter++;
				if(number[0]>0) stream_summary.progress = number[0];
			}
		}
		// if(stream_summary.progress && stream_summary.duration && stream_summary.progress+10>stream_summary.duration){
		// 	kill_peerflix();
		// }
	});

	client.start();
}

function finish_streaming (){
	clearInterval(vlc_monitoring);
	is_streaming = false;

	// kill peerflix
	kill_peerflix();

	// clean peerflix & vlc PID
	fs.unlink(peerflix_pid);
	fs.unlink(vlc_pid);

	console.log("finish");

	//check that we have all the data we need and log it to db
	if(stream_summary.showId && stream_summary.season && stream_summary.episode && stream_summary.duration && stream_summary.progress){
		var setModifier = { $set: {} };
		if(stream_summary.season && stream_summary.episode){
			setModifier.$set["last_watched.season"] = stream_summary.season;
			setModifier.$set["last_watched.episode"] = stream_summary.episode;
			clean_watch_log_after(stream_summary.showId, stream_summary.season, stream_summary.episode);
		}
		if(stream_summary.progress && stream_summary.duration){
			setModifier.$set["last_watched.progress"] = stream_summary.progress;
			setModifier.$set["last_watched.duration"] = stream_summary.duration;
			setModifier.$set["season."+stream_summary.season+".episode."+stream_summary.episode+".duration"] = stream_summary.duration;
			setModifier.$set["season."+stream_summary.season+".episode."+stream_summary.episode+".progress"] = stream_summary.progress;
		}

		// TODO if it a few episodes in a row are watched, add to favorites
		// TODO prepare next episode by checking if everything is up to date (tvinfo, seasoninfo, what is the next ep, fetch magnet for next)

		db.shows.update({
			id: parseInt(stream_summary.showId)
		}, setModifier, {}, (function (stream_summary, err, numReplaced, newDoc){
			console.log("logging "+stream_summary.showName+" at "+Math.round(100*stream_summary.progress/stream_summary.duration)+"%");
		}).bind(undefined, stream_summary));


	}

	console.log('all done');
}

function clean_watch_log_after (show_id, season_number, episode_number) {
	db.shows.findOne({ id: parseInt(show_id) }, (function (season_number, episode_number, err, doc) {
		var setModifier = { $unset: {} };
		var season_keys = Object.keys(doc.season);
		for (var i = 0, l = season_keys.length; i < l; i++) {
			if(parseInt(season_keys[i])>=season_number){
				var episode_keys = Object.keys(doc.season[""+season_keys[i]+""].episode);
				for (var j = 0, m = episode_keys.length; j < m; j++) {
					if((parseInt(season_keys[i])==season_number && parseInt(episode_keys[j])>episode_number) || parseInt(season_keys[i])>season_number){
						setModifier.$unset["season."+season_keys[i]+".episode."+episode_keys[j]+".duration"] = true;
						setModifier.$unset["season."+season_keys[i]+".episode."+episode_keys[j]+".progress"] = true;
					}
				};
			}
		}
		db.shows.update({
			id: parseInt(doc.id)
		}, setModifier, {}, function(){});
	}).bind(undefined, season_number, episode_number));
}

function kill_peerflix(){
	fs.readFile(peerflix_pid, 'utf8', function (err, data) {
		process.kill(data, 'SIGINT');
		console.log("peerflix killed");
	});
}


///////////////////////////////////////
//  COLLECTING ANONYMOUS USAGE DATA  //
///////////////////////////////////////
setTimeout(anonymous, 5000);
var anonymous_id = process.env.HOME + "/Library/Application Support/Alfred 2/Workflow Data/florian.show"
function anonymous () {
	fs.exists(anonymous_id, function (exist) {
		if(!exist) fs.mkdir(anonymous_id, write_anonymous_id);
		else{
			fs.exists(anonymous_id+"/id", function (exist) {
				if (exist){
					fs.readFile(anonymous_id+"/id", 'utf8', function (err, data) {
						send_anonymous(data);
					})
				} else
					write_anonymous_id();
			})
		}
	})
}
function send_anonymous(guid) {
	if(!request) request = require('request');
	request("http://alfred.florianpellet.com/show/show_ping.php?guid="+guid, function () {});
}
function write_anonymous_id () {
	var guid = ""+Date.now()+(process.env.HOME.split("/").pop());
	fs.writeFile(anonymous_id+"/id", guid);
	send_anonymous(guid);
}



/* PASTEBIN & SNIPPETS

the movie DB
	image sizes: https://image.tmdb.org/t/p/{size}/iRDNn9EHKuBhGa77UBteazvsZa1.jpg
		available: w60_or_h91, w92, w130, w185, w300, w396, w780, w1280, original

# stream from VLC to HTML <video><source src="http://localhost:8081/test" type="video/ogg" /></video>
/Applications/VLC.app/Contents/MacOS/VLC ~/Movies/New.Girl.S04E03.720p.HDTV.x264-KILLERS.mkv --sout '#transcode{vcodec=theo,vb=2000,scale=1,acodec=vorb,ab=128,channels=2,samplerate=44100}:http{mux=ogg,dst=:8081/test}'
*/
var weird_block2 = 0;
var weird_block1 = 0;
/*
 * TODO:
 * read user prefs from file?
 * 'miscTopRatedTvs' should only be adding to the list of already watched shows (in the case of empty query)
 * remove old db entries in post-processing
 * fetch latest episodes for watched shows in post-processing
 * query piratebay as early as possible (if the user is almost up to date, the desired episode is probably on the search page without specifying sXXeXX)
 * switch to `sips` for image croping: sips -c 60 60 imagename.jpg
 * add a no-result case
 * use "season" torrents if nothing else available
 *
 */

///////////////
// VARIABLES //
///////////////

var DEBUG = true;
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

// server
var host = process.argv[2]?process.argv[2].split(':'):['127.0.0.1','8374'];
var server_life = DEBUG?5000:40000;
var http_response;

// user prefs
var mdb_API_key = "26607a596b2ac49958a20ec3ab295259";

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
var justCreated = true;
var db = {};
var now = new Date(Date.now());
var timeout = setTimeout(exit_server, server_life);
var exitInterval;
var dontLeave = 0;


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
			else
				search_for_show(post['query']);

			if(is_streaming)
				post_process_while_streaming = setTimeout(post_processing, delay_before_post_process);

			if(justCreated)
				finish_loading();
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


///////////////////////
//  STREAMING LOGIC  //
///////////////////////

function handle_stream (info, id){
	http_response.end('ok');
	is_streaming = true;

	// parse info
	stream_summary.showId = id;
	stream_summary.showName = info.split(', S');
	stream_summary.season = stream_summary.showName[1].split('E');
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
	var get_length = (stream_summary.progress && !stream_summary.duration && (stream_summary.monitorCounter++)>30);

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
				console.log("progress: "+number[0]+"s ("+stream_summary.showName+" s"+stream_summary.season+" e"+stream_summary.episode+")");
				stream_summary.progress = number[0];
			}
		}
	});

	client.start();
}

function finish_streaming (){
	clearInterval(vlc_monitoring);
	is_streaming = false;
	console.log("finish");

	//check that we have all the data we need and log it to db
	console.log(stream_summary);
	if(stream_summary.showId && stream_summary.season && stream_summary.episode && stream_summary.duration && stream_summary.progress){
		var setModifier = { $set: {} };
		setModifier.$set["last_watched.season"] = stream_summary.season;
		setModifier.$set["last_watched.episode"] = stream_summary.episode;
		setModifier.$set["last_watched.progress"] = stream_summary.progress;
		setModifier.$set["last_watched.duration"] = stream_summary.duration;
		setModifier.$set["season."+stream_summary.season+".episode."+stream_summary.episode+".duration"] = stream_summary.duration;
		setModifier.$set["season."+stream_summary.season+".episode."+stream_summary.episode+".progress"] = stream_summary.progress;
		db.shows.update({
			id: stream_summary.showId
		}, setModifier, {}, (function (stream_summary, err, numReplaced, newDoc){
			console.log("logging "+stream_summary.showName+" at "+Math.round(100*stream_summary.progress/stream_summary.duration)+"%");
		}).bind(undefined, stream_summary));
	}

	// kill peerflix
	fs.readFile(peerflix_pid, 'utf8', function (err, data) {
		process.kill(data, 'SIGINT');
		console.log("peerflix killed");
	});

	// clean peerflix & vlc PID
	fs.unlink(peerflix_pid);
	fs.unlink(vlc_pid);

	console.log('all done');
}


///////////////////////
//  INTERFACE LOGIC  //
///////////////////////

function initialize () {
	//create db folder
	if(!fs.existsSync(db_folder)) fs.mkdirSync(db_folder);
}

function finish_loading () {
	justCreated = false;
	if(!db.xml) db.xml = new Datastore({ filename: db_folder+"/xml.db", autoload: true });
	if(!db.queries_history) db.queries_history = new Datastore({ filename: db_folder+"/queries_history.db", autoload: true });
	if(!db.shows) db.shows = new Datastore({ filename: db_folder+"/shows.db", autoload: true });
	if(!cheerio) cheerio = require('cheerio');
	if(!mdb) mdb = require('moviedb')(mdb_API_key);
	if(!request) request = require('request');
}

function search_for_show (query) {
	query = query || 'miscTopRatedTvs';
	query = query.trim();

	console.log("query: "+query);

	if(!db.xml) db.xml = new Datastore({ filename: db_folder+"/xml.db", autoload: true });
	db.xml.findOne({ query: query}, function (err, doc) {
		if(false && doc && doc.timestamp > Date.now()-60*60*1000){ // WARNING TODO deactivated direct xml restitution
			console.log("from previous query");
			if(DEBUG)
				console.log(doc.xml);
			else
				http_response.end(doc.xml);
		} else {
			w.for_query = query;

			if(!db.queries_history) db.queries_history = new Datastore({ filename: db_folder+"/queries_history.db", autoload: true });
			db.queries_history.findOne({ query: query }, (function (query, err, doc) { // check if we have a recent enough (1 day) result from this query
				if(doc && doc.timestamp < Date.now()+24*60*60*1000){
					console.log("using stored query results");
					use_results(doc.results, query);
				} else {
					console.log("new query to mdb");
					if(!mdb) mdb = require('moviedb')(mdb_API_key);
					mdb[(query=='miscTopRatedTvs'?'miscTopRatedTvs':'searchTv')]( // if we don't, then query The Movie DB to get one and store it in the db
						(query=='miscTopRatedTvs'?{}:{query: query, page: 1, search_type: "ngram"}),
						(function (query, err, res) {

							db.queries_history.update({
								query: query
							}, {
								query: query,
								timestamp: Date.now(),
								results: res.results
							}, { upsert: true });

							if(!db.shows) db.shows = new Datastore({ filename: db_folder+"/shows.db", autoload: true });
							for (var i = 0, l = res.results.length; i < l; i++) { // take that opportunity to make sure we have all name->id associations in the shows.db
								if(good_enough_show(res.results[i])){
									db.shows.update({
										id: res.results[i].id
									}, {
										name: res.results[i].name,
										id: res.results[i].id,
										poster_path: res.results[i].poster_path,
										first_air_date: res.results[i].first_air_date,
										vote_average: res.results[i].vote_average,
										popularity: res.results[i].popularity
									}, { upsert: true });
								}
							};

							use_results(res.results, query);

						}).bind(undefined, query)
					);
				}
			}).bind(undefined, query));
		}
	})
}

function use_results (results, query) {
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
	if(good_shows_count>1) only_one_good_show = false;

	if((only_one_good_show && simplify_str(query)==simplify_str(only_one_good_show.name)) || query==exact_match.name){
		console.log("details (exact match or single approximate match)");
		if(exact_match) only_one_good_show = exact_match;
		if(!db.shows) db.shows = new Datastore({ filename: db_folder+"/shows.db", autoload: true });
		db.shows.findOne({ id: only_one_good_show.id }, function (err, doc) {
			if(doc && doc.timestamp && doc.timestamp>Date.now()-12*60*60*1000){ // if we have info recent enough (based on previously recorded dates) about it, use it
				console.log("this show already exists (with recent tvinfo details) in the database");
				//find latest season & if not up to date, query mdb
				var temp_latest_season = find_latest(doc.season);
				if(!temp_latest_season || (temp_latest_season && !temp_latest_season.timestamp) || (temp_latest_season && temp_latest_season.timestamp && temp_latest_season.timestamp<Date.now()-12*60*60*1000)){
					detail_season(temp_latest_season.season_number, doc);
				} else {
					output_show(doc);
				}
			} else { // otherwise, query the info and store it
				console.log("updating tvInfo for this show");
				mdb.tvInfo({id: doc.id}, (function (doc, err, res) {

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
					if(!doc["season"]) doc["season"] = {};
					for (var i = 0, l = res.seasons.length; i < l; i++) {
						doc["season"][""+res.seasons[i].season_number+""] = res.seasons[i];
					};
					db.shows.update({
						id: doc.id
					}, doc, {}, function (){
						console.log("-> updated "+(doc.name?doc.name:"")+" with tv_info");
					});

					var temp_latest_season = find_latest(res.seasons);
					if(temp_latest_season){
						detail_season(temp_latest_season.season_number, doc);
					} else {
						output_show(doc);
					}
				}).bind(undefined, doc))
			}
		});
	} else {
		console.log("showing search results");
		for (var i = 0, l = results.length; i < l; i++) {
			if(good_enough_show(results[i])){
				//add to xml
				w.add(results[i].id, results[i].name, "", "");
				w.last_result.autocomplete = results[i].name;
				w.last_result.icon = fs.existsSync(imgs_folder+"/"+results[i].id+".jpg")?imgs_folder+"/"+results[i].id+".jpg":"icon.png";
				w.last_result.valid = "NO";
			}
		};
		w.echo();
	}
}

function detail_season (season_number, doc) {
	console.log("updating tvSeasonInfo for season "+season_number)

	mdb.tvSeasonInfo({id: doc.id, season_number: season_number}, (function (doc, err, res) {

		doc["season"][""+res.season_number+""]["timestamp"] = Date.now();
		doc["season"][""+res.season_number+""]["name"] = res.name;
		doc["season"][""+res.season_number+""]["overview"] = res.overview;
		doc["season"][""+res.season_number+""]["air_date"] = res.air_date;
		if(!doc["season"][""+res.season_number+""]["episode"]) doc["season"][""+res.season_number+""]["episode"] = {};
		for (var i = 0, l = res.episodes.length; i < l; i++) {
			if(!doc["season"][""+res.season_number+""]["episode"][""+res.episodes[i].episode_number+""]) doc["season"][""+res.season_number+""]["episode"][""+res.episodes[i].episode_number+""] = {};
			doc["season"][""+res.season_number+""]["episode"][""+res.episodes[i].episode_number+""]["episode_number"] = res.episodes[i].episode_number;
			doc["season"][""+res.season_number+""]["episode"][""+res.episodes[i].episode_number+""]["air_date"] = res.episodes[i].air_date;
			doc["season"][""+res.season_number+""]["episode"][""+res.episodes[i].episode_number+""]["name"] = res.episodes[i].name;
			doc["season"][""+res.season_number+""]["episode"][""+res.episodes[i].episode_number+""]["overview"] = res.episodes[i].overview;
			doc["season"][""+res.season_number+""]["episode"][""+res.episodes[i].episode_number+""]["id"] = res.episodes[i].id;
			doc["season"][""+res.season_number+""]["episode"][""+res.episodes[i].episode_number+""]["still_path"] = res.episodes[i].still_path;
		};
		db.shows.update({
			id: doc.id
		}, doc, {}, function (){
			console.log("-> updated "+(doc.name?doc.name:"")+" with tvSeasonInfo");
		});

		output_show(doc);

	}).bind(undefined, doc))
}

function output_show (show) {
	//next for me to watch

	//next ep
	if(show.status != "Ended"){
		var release_str = parse_date(show.last_air_date);

		if(release_str)
			w.add("", (find_latest(show.season)?"Next":"First")+" episode "+release_str, show.last_air_date, "");
		else
			w.add("", (find_latest(show.season)?"Next":"First")+" episode's air date not set yet", "", "");
	}

	// add (or remove) from my favorites
	if(show.fav==true)
		w.add("", "Remove "+show.name+" from my favorites", "", "");
	else
		w.add("", "Add "+show.name+" to my favorites", "", "");
	w.last_result.icon = "love.png";

	//details
	var ratings = Math.round(show.vote_average/2)
	var stars = "";
	for (var i = 1; i < 6; i++) {
		stars+=i>ratings?"☆":"★"
	};
	var year = show.first_air_date.split("-")[0];
	var genres = "";
	for (var i = 0, l = show.genres.length; i < l; i++) {
		genres += (i>0?", ":"")+show.genres[i].name;
	};
	make_preview_page(show.id, show.name, genres, ratings, show.status, year, show.overview);
	w.add("", show.overview, stars+" ("+year+") "+genres+" — "+show.status, "l"+show.id);
	w.last_result.largetype = show.overview;
	w.last_result.icon = "what.png";

	//latest ep
	var latest_season = find_latest(show.season);
	if(latest_season && latest_season.episode){
		var latest_ep = find_latest(latest_season.episode);
		var formated_episode_nb = "S"+leading_zero(latest_season.season_number)+"E"+leading_zero(latest_ep.episode_number);
		if(latest_ep && latest_ep.magnet){
			console.log("pulling magnet from db")
			var title = "latest episode: "+formated_episode_nb+" "+latest_ep.name;
			var subtitle = latest_ep.magnet.piratebay?"↵ to stream "+latest_ep.magnet.piratebay.name:"Not available on piratebay";
			if(latest_ep.magnet.piratebay)
				w.add("", title, subtitle, "m"+show.id+" "+latest_ep.magnet.piratebay.magnetLink+" "+show.name+", "+formated_episode_nb+": "+latest_ep.name);
			else{
				w.add("", title, subtitle, "");
				w.last_result.valid = "NO";
			}
			w.echo();
		} else {
			console.log("fetching magnet from piratebay");
			search_piratebay(show.name+" "+formated_episode_nb, (function (latest_ep, latest_season_number, results) {
				var title = "latest episode: "+formated_episode_nb+" "+latest_ep.name;
				var subtitle = results.length>0?"↵ to stream "+results[0].name:"Not available on piratebay";
				if(results.length>0)
					w.add("", title, subtitle, "m"+show.id+" "+results[0].magnetLink+" "+show.name+", "+formated_episode_nb+": "+latest_ep.name);
				else{
					w.add("", title, subtitle, "");
					w.last_result.valid = "NO";
				}
				w.echo();
				var fieldName = "season."+latest_season_number+".episode."+latest_ep.episode_number+".magnet";
				var setModifier = { $set: {} };
				setModifier.$set[fieldName+".timestamp"] = Date.now();
				setModifier.$set[fieldName+".piratebay"] = (results.length>0)?results[0]:false;
				db.shows.update({
					id: show.id
				}, setModifier, { upsert: true }, function (err, numReplaced, newDoc){
					console.log("-> updated magnet "+(numReplaced>0?">0":"false"));
				});
			}).bind(undefined, latest_ep, latest_season.season_number));
		}
	} else {
		w.echo();
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

function parse_date (date) {
	var next_air_date = date.split("-");
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
				next_ep_str = "on "+(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][next_air_date.getDay()]);
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

function simplify_str (str) {
	return str.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function leading_zero (str) {
	return (""+str+"").length==1?"0"+str:str;
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
				fs.unlink(node_pid);
				process.exit();
			}
		}, 5000);
	} else {
		timeout = setTimeout(exit_server, server_life);
	}
}

function post_processing () {
	// clean & optimize db
	db.shows.ensureIndex({ fieldName: 'id', unique: true }, function (err) {});
	db.queries_history.ensureIndex({ fieldName: 'query', unique: true }, function (err) {});
	for (var i = db.length - 1; i >= 0; i--) {
		db[i].persistence.compactDatafile;
	};

	// dl & crop images
	if(!fs.existsSync(imgs_folder)) fs.mkdirSync(imgs_folder);
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


///////////////////////////////////////////
//  DEAL WITH THE MOVIE DATABASE THINGS  //
///////////////////////////////////////////

function date_from_tmdb_format (tmdb_date){
	var temp_date = tmdb_date.split("-");
	return new Date(temp_date[0], temp_date[1]-1, temp_date[2])
}

function find_latest(array) {
    var latest;
    var now = Date.now();
    for (var i = (array.isArray?array.length:Object.keys(array).length) - 1; i >= 0; i--) {
    	var index = (array.isArray?i:Object.keys(array)[i])

    	//prevent season 0 (usually "specials") from being the latest thing (even though it can technically be as "bonuses" are sometimes released afterwards)
    	if((array.isArray && array[index].season_number == 0) || (!array.isArray && index == "0"))
    		continue;

    	//initialize with any
    	if(!latest){
    		latest = array[index];
    		continue;
    	}

        //if "air_date" is defined for array[index] and is greater than that of latest (or latest's is undefined) but still smaller than Date.now()
        if (array[index].air_date && (!latest.air_date || array[index].air_date.localeCompare(latest.air_date) > 0) && now > date_from_tmdb_format(array[index].air_date)) latest = array[index];
    };
    return (latest && latest.air_date) ? latest : false;
}

function good_enough_show (show) {
	return (show.first_air_date && show.first_air_date.split("-")[0]>1990 && show.popularity>0.008 && show.poster_path);
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
	this.last_result;
	this.xml = "";
	this.for_query;

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
		this.uid = "";
		this.arg = "";
		this.valid = "YES";
		this.autocomplete = "";
		this.type;

		this.title = "Title";
		this.subtitle = "Subtitle";
		this.icontype;
		this.icon = "";

		this.shift;
		this.fn;
		this.ctrl;
		this.alt;
		this.cmd;
		this.copy;
		this.largetype;
	}

	this.add = function (uid, title, subtitle, arg) {
		this.wrap_last();
		this.last_result = new this.result();
		this.last_result.uid = uid;
		this.last_result.title = title;
		this.last_result.subtitle = subtitle;
		this.last_result.arg = arg;
	}

	this.wrap_last = function () {
		if(this.last_result){

			if(this.last_result.uid) this.last_result.uid = escapeXml(this.last_result.uid);
			if(this.last_result.arg) this.last_result.arg = escapeXml(this.last_result.arg);
			if(this.last_result.valid) this.last_result.valid = escapeXml(this.last_result.valid);
			if(this.last_result.autocomplete) this.last_result.autocomplete = escapeXml(this.last_result.autocomplete);
			if(this.last_result.type) this.last_result.type = escapeXml(this.last_result.type);
			if(this.last_result.title) this.last_result.title = escapeXml(this.last_result.title);
			if(this.last_result.subtitle) this.last_result.subtitle = escapeXml(this.last_result.subtitle);
			if(this.last_result.icontype) this.last_result.icontype = escapeXml(this.last_result.icontype);
			if(this.last_result.icon) this.last_result.icon = escapeXml(this.last_result.icon);
			if(this.last_result.shift) this.last_result.shift = escapeXml(this.last_result.shift);
			if(this.last_result.fn) this.last_result.fn = escapeXml(this.last_result.fn);
			if(this.last_result.ctrl) this.last_result.ctrl = escapeXml(this.last_result.ctrl);
			if(this.last_result.alt) this.last_result.alt = escapeXml(this.last_result.alt);
			if(this.last_result.cmd) this.last_result.cmd = escapeXml(this.last_result.cmd);
			if(this.last_result.copy) this.last_result.copy = escapeXml(this.last_result.copy);
			if(this.last_result.largetype) this.last_result.largetype = escapeXml(this.last_result.largetype);

			this.xml+="\n<item uid=\""+this.last_result.uid+"\" valid=\""+this.last_result.valid+"\" autocomplete=\""+this.last_result.autocomplete+"\""+(this.last_result.type?" type=\""+this.last_result.type+"\"":"")+">";
			this.xml+="\n<title>"+this.last_result.title+"</title>";
			this.xml+="\n<subtitle>"+this.last_result.subtitle+"</subtitle>";
			this.xml+="\n<arg>"+this.last_result.arg+"</arg>";
			this.xml+="\n<icon"+(this.last_result.icontype?" type=\""+this.last_result.icontype+"\"":"")+">"+this.last_result.icon+"</icon>";
			if(this.last_result.shift) this.xml+="\n<subtitle mod=\"shift\">"+this.last_result.shift+"</subtitle>";
			if(this.last_result.fn) this.xml+="\n<subtitle mod=\"fn\">"+this.last_result.fn+"</subtitle>";
			if(this.last_result.ctrl) this.xml+="\n<subtitle mod=\"ctrl\">"+this.last_result.ctrl+"</subtitle>";
			if(this.last_result.alt) this.xml+="\n<subtitle mod=\"alt\">"+this.last_result.alt+"</subtitle>";
			if(this.last_result.cmd) this.xml+="\n<subtitle mod=\"cmd\">"+this.last_result.cmd+"</subtitle>";
			if(this.last_result.copy) this.xml+="\n<text type=\"copy\">"+this.last_result.copy+"</text>";
			if(this.last_result.largetype) this.xml+="\n<text type=\"largetype\">"+this.last_result.largetype+"</text>";
			this.xml+="\n</item>";
		}
	}

	this.echo = function () {
		this.wrap_last();
		if(DEBUG)
			console.log("\n\n<?xml version=\"1.0\"?><items>"+this.xml+"\n</items>");
		else
			http_response.end("<?xml version=\"1.0\"?><items>"+this.xml+"\n</items>");
		log_query_xml("<?xml version=\"1.0\"?><items>"+this.xml+"\n</items>", this.for_query);
		this.xml = "";
		this.last_result = undefined;
		this.for_query = undefined;
	}

	function log_query_xml (xml, query) {
		if(!db.xml) db.xml = new Datastore({ filename: db_folder+"/xml.db", autoload: true });

		db.xml.update({
			query: query
		}, {
			query: query,
			timestamp: Date.now(),
			xml: xml
		}, { upsert: true });

	}
}



/* PASTEBIN & SNIPPETS

the movie DB
	image sizes: https://image.tmdb.org/t/p/{size}/iRDNn9EHKuBhGa77UBteazvsZa1.jpg
		available: w60_or_h91, w92, w130, w185, w300, w396, w780, w1280, original

Bash commands

#start peerflix
peerflix "magnet:?xt=urn:btih:513e51db00d3fc91c0f8c5090749f058cd0b263d&dn=Homeland+S03E05+HDTV+x264-KILLERS+%5Beztv%5D&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80&tr=udp%3A%2F%2Ftracker.publicbt.com%3A80&tr=udp%3A%2F%2Ftracker.istole.it%3A6969&tr=udp%3A%2F%2Fopen.demonii.com%3A1337" -q -f /private/tmp/torrent-stream/ -h 127.0.0.1 -p 8375

# start vlc
/Applications/VLC.app/Contents/MacOS/VLC -I macosx --extraintf oldrc --extraintf rc --rc-host http://127.0.0.1:8765 --meta-title "Show Name, SXXEXX: Name of the episode" http://127.0.0.1:8375/

# query vlc
echo get_time | nc 127.0.0.1 8765
echo get_length | nc 127.0.0.1 8765
#or processed:
time=$(echo get_time | nc 127.0.0.1 8765 | sed -n '3p')
time=${time:2}

# stream from VLC to HTML <video><source src="http://localhost:8081/test" type="video/ogg" /></video>
/Applications/VLC.app/Contents/MacOS/VLC ~/Movies/New.Girl.S04E03.720p.HDTV.x264-KILLERS.mkv --sout '#transcode{vcodec=theo,vb=2000,scale=1,acodec=vorb,ab=128,channels=2,samplerate=44100}:http{mux=ogg,dst=:8081/test}'
*/
var weird_block2 = 0;
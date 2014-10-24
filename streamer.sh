#!/bin/bash
export PATH=$PATH:/usr/local/bin

bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
episodes="${cache}/episodes/"
PEERFLIX_PID="${cache}/peerflix.pid"
NODE_PID="${cache}/node.pid"
init=$(date +%s);

QUERY="$1"
case_letter=${QUERY:0:1}
QUERY=${QUERY:1}

function start_server {
	# kickoff server if it isn't running
	if [[ ! -f ${NODE_PID} ]] || ( ! ps -p $(cat "${NODE_PID}") > /dev/null ); then
		# launch server
		nohup node ./server.js 127.0.0.1:8374 &> node-out.txt &
		# and store NODE_PID
		echo $! > "${NODE_PID}"
	fi
}

# case "m" for magnet
if [[ $case_letter == "m" ]] ; then
	# wait for peerflix and VLC to die
	if [[ -f ${PEERFLIX_PID} ]] && kill -0 $(cat "${PEERFLIX_PID}"); then
		while kill -0 $(cat "${PEERFLIX_PID}"); do echo prf-alive; done
	fi

	# parsing input
	id=$(echo $QUERY| cut -d " " -f1)
	progress=$(echo ${QUERY:${#id}}| cut -d " " -f1)
	magnet=$(echo ${QUERY:$[${#progress}+${#id}]+2}| cut -d " " -f1)
	title=${QUERY:$[${#magnet}+${#progress}+${#id}]+3}

	# send notification
	terminal-notifier -title "Loading torrent..." -message "$title" -sender com.runningwithcrayons.Alfred-2 -contentImage "${cache}/imgs/$id.jpg"

	start_server

	# start peerflix
	node ./node_modules/peerflix/app.js "$magnet" -q -f "${episodes}" -v -h 127.0.0.1 -p 8375 -- http://127.0.0.1:8375 -I macosx --start-time $progress --extraintf oldrc --extraintf rc --rc-host http://127.0.0.1:8376 --meta-title "\"$title\"" --play-and-exit &
	echo $! > "${PEERFLIX_PID}"

	# wait for server response (in case node isn't done launching yet)
	until out=$(curl 127.0.0.1:8374 -s -d "stream=$title" -d "show_id=$id" -d "player=vlc") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done
	echo " "

fi
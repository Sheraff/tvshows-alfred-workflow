#!/bin/bash
export PATH=$PATH:/usr/local/bin

bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
data=${HOME}/Library/Application\ Support/Alfred\ 2/Workflow\ Data/${bundle}
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
		nohup node ./server.js 127.0.0.1:8374 &> "${cache}/node-out.txt" &
		# and store NODE_PID
		echo $! > "${NODE_PID}"
	fi
}

# case "m" for magnet
if [[ $case_letter == "m" ]] ; then
	# wait for peerflix
	if [[ -f ${PEERFLIX_PID} ]] && kill -0 $(cat "${PEERFLIX_PID}"); then
		while kill -0 $(cat "${PEERFLIX_PID}"); do :; done
	fi

	# parsing input
	id=$(echo $QUERY| cut -d " " -f1)
	progress=$(echo ${QUERY:${#id}}| cut -d " " -f1)
	magnet=$(echo ${QUERY:$[${#progress}+${#id}]+2}| cut -d " " -f1)
	title=${QUERY:$[${#magnet}+${#progress}+${#id}]+3}

	# send notification
	terminal-notifier -title "Loading torrent..." -message "$title" -sender com.runningwithcrayons.Alfred-2 -contentImage "${data}/imgs/$id.jpg"

	start_server

	# start peerflix
	if hash mpv 2> /dev/null; then
		nohup node ./node_modules/peerflix/app.js "$magnet" -q -f "${episodes}" -k -- --start=$progress --input-unix-socket=socket.io --title="\"$title\"" &
		player="mpv"
	else
		nohup node ./node_modules/peerflix/app.js "$magnet" -q -f "${episodes}" -v -- -I macosx --start-time $progress --extraintf oldrc --extraintf rc --rc-host http://127.0.0.1:8376 --meta-title "\"$title\"" --play-and-exit &
		player="VLC"
	fi
	echo $! > "${PEERFLIX_PID}"

	# wait for server response (in case node isn't done launching yet)
	until out=$(curl 127.0.0.1:8374 -s -d "stream=$title" -d "show_id=$id" -d "player=$player") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done
	echo " "

fi
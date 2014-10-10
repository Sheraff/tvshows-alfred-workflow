#!/bin/bash
export PATH=$PATH:/usr/local/bin

bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
PEERFLIX_PID="${cache}/peerflix.pid"
VLC_PID="${cache}/vlc.pid"
NODE_PID="${cache}/node.pid"
node="/usr/local/bin/node" # I believe this line is unnecessary as I export the PATH above already

QUERY="$1"
case_letter=${QUERY:0:1}
QUERY=${QUERY:1}

function start_server {
	# kickoff server if it isn't running
	if [[ ! -f ${NODE_PID} ]] || ( ! ps -p $(cat "${NODE_PID}") > /dev/null ); then
		# launch server
		nohup ${node} ./server.js 127.0.0.1:8374 &> node-out.txt &
		# and store NODE_PID
		echo $! > "${NODE_PID}"
	fi
}

# case "m" for magnet
if [[ $case_letter == "m" ]] ; then
	# wait for peerflix and VLC to die
	while [[ -f ${PEERFLIX_PID} ]] && [[ -f ${VLC_PID} ]]; do :; done

	# parsing input
	id=$(echo $QUERY| cut -d " " -f1)
	progress=$(echo ${QUERY:${#id}}| cut -d " " -f1)
	magnet=$(echo ${QUERY:$[${#progress}+${#id}]+2}| cut -d " " -f1)
	title=${QUERY:$[${#magnet}+${#progress}+${#id}]+3}

	# send notification
	terminal-notifier -title "Loading torrent..." -message "$title" -sender com.runningwithcrayons.Alfred-2 -contentImage "${cache}/imgs/$id.jpg"

	start_server

	# start peerflix (we should kill any previously running instance of peerflix here, based on PEERFLIX_PID)
	peerflix "$magnet" -q -f /private/tmp/torrent-stream/ -h 127.0.0.1 -p 8375 &
	echo $! > "${PEERFLIX_PID}"

	# wait for video to be available and then start VLC with tcp connection
	until out=$(curl --head -f -s 127.0.0.1:8375); do :; done
	/Applications/VLC.app/Contents/MacOS/VLC -I macosx --start-time $progress --extraintf oldrc --extraintf rc --rc-host http://127.0.0.1:8376 --meta-title "$title" http://127.0.0.1:8375/ &
	echo $! > "${VLC_PID}"

	# wait for server response (in case node isn't done launching yet)
	until out=$(curl 127.0.0.1:8374 -s -d "stream=$title" -d "show_id=$id"); do :; done
	echo " "

fi
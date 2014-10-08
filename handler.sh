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

# case "l" (originally) for large-type
if [[ $case_letter == "l" ]] ; then
	qlmanage -p "${cache}/summaries/$QUERY.rtf"

# case "f" for favorite
elif [[ $case_letter == "f" ]] ; then
	start_server
	until out=$(curl 127.0.0.1:8374 -s -d "fav=${QUERY:1}" -d "bool=${QUERY:0:1}"); do :; done
	echo " "

# case "m" for magnet
elif [[ $case_letter == "m" ]] ; then
	# remove existing instances of peerflix & vlc (that we're responsible for)
	if [[ ! -f ${PHP_PID_FILE} ]]; 	then kill -SIGKILL $(cat "${PEERFLIX_PID}"); fi
	if [[ ! -f ${VLCFILE} ]]; 		then kill -SIGKILL $(cat "${VLC_PID}"); fi # first time around, i decided not to add this line, second time, i didn't remember why so i added it... maybe there was a good reason

	# parsing input
	id=$(echo $QUERY| cut -d " " -f1)
	magnet=$(echo ${QUERY:${#id}}| cut -d " " -f1)
	title=${QUERY:$[${#magnet}+${#id}]+2}

	# send notification
	terminal-notifier -title "Loading torrent..." -message "$title" -sender com.runningwithcrayons.Alfred-2 -contentImage "${cache}/imgs/$id.jpg"

	start_server

	# start peerflix (we should kill any previously running instance of peerflix here, based on PEERFLIX_PID)
	peerflix "$magnet" -q -f /private/tmp/torrent-stream/ -h 127.0.0.1 -p 8375 &
	echo $! > "${PEERFLIX_PID}"

	# wait for video to be available and then start VLC with tcp connection
	until out=$(curl --head -f -s 127.0.0.1:8375); do :; done
	/Applications/VLC.app/Contents/MacOS/VLC -I macosx --extraintf oldrc --extraintf rc --rc-host http://127.0.0.1:8376 --meta-title "$title" http://127.0.0.1:8375/ &
	echo $! > "${VLC_PID}"

	# wait for server response (in case node isn't done launching yet)
	until out=$(curl 127.0.0.1:8374 -s -d "stream=$title" -d "show_id=$id"); do :; done
	echo " "

fi
#!/bin/bash
export PATH=$PATH:/usr/local/bin

# QUERY="32858 magnet:?xt=urn:btih:9b9c9ff5558d2d2bf40c7f9caecfce55480ebfef&dn=Game+of+Thrones+S04E10+HDTV+x264-KILLERS%5Bettv%5D&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80&tr=udp%3A%2F%2Ftracker.publicbt.com%3A80&tr=udp%3A%2F%2Ftracker.istole.it%3A6969&tr=udp%3A%2F%2Fopen.demonii.com%3A1337 Game of Thrones, S04E10: The Children"
QUERY="$1"
bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
PEERFLIX_PID="${cache}/peerflix.pid"
VLC_PID="${cache}/vlc.pid"
NODE_PID="${cache}/node.pid"
node="/usr/local/bin/node" # I believe this line is unnecessary as I export the PATH above already

# remove existing instances of peerflix & vlc (that we're responsible for)
kill -SIGKILL $(cat "${PEERFLIX_PID}")
kill -SIGKILL $(cat "${VLC_PID}") # first time around, i decided not to add this line, second time, i didn't remember why so i added it... maybe there was a good reason

# parsing input
id=$(echo $QUERY| cut -d " " -f1)
magnet=$(echo ${QUERY:${#id}}| cut -d " " -f1)
title=${QUERY:$[${#magnet}+${#id}]+2}

# send notification
terminal-notifier -title "Loading torrent..." -message "$title" -sender com.runningwithcrayons.Alfred-2 -contentImage "${cache}/imgs/$id.jpg"

# kickoff server if it isn't running
if [[ ! -f ${NODE_PID} ]] || ( ! ps -p $(cat "${NODE_PID}") > /dev/null ); then
	# launch server
	nohup ${node} ./server.js 127.0.0.1:8374 &> node-out.txt &
	# and store NODE_PID
	echo $! > "${NODE_PID}"
fi

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
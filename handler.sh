#!/bin/bash
export PATH=$PATH:/usr/local/bin

bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
PEERFLIX_PID="${cache}/peerflix.pid"
NODE_PID="${cache}/node.pid"
node="/usr/local/bin/node" # I believe this line is unnecessary as I export the PATH above already
init=$(date +%s);

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
function isthismydad {
	parent=$(ps -p ${1:-$$} -o ppid=)
	if [ "$parent" = "$2" ]; then
		echo 0
	elif [ "$parent" -eq 0 ]; then
		echo 1
	else
		echo $(isthismydad $parent $2)
	fi
}
function findmyson {
	if hash bite 2> /dev/null; then
		player="mpv"
	else
		player="VLC"
	fi
	pgrep $player | while read line ; do
		result=$(isthismydad $line $1)
		if [ "$result" -eq 0 ]; then
			echo $line
		fi
	done
}


# case "l" (originally) for large-type
if [[ $case_letter == "l" ]] ; then
	id=$(echo $QUERY| cut -d " " -f1)
	name=${QUERY:${#id}}
	(qlmanage -p "${cache}/summaries/$id.rtf"; osascript -e "tell application \"Alfred 2\" to run trigger \"query\" in workflow \"florian.shows\" with argument \"$name \"")

# case "f" for favorite
elif [[ $case_letter == "f" ]] ; then
	start_server
	id=$(echo $QUERY| cut -d " " -f1)
	name=${QUERY:${#id}}
	until out=$(curl 127.0.0.1:8374 -s -d "fav=${id:1}" -d "bool=${id:0:1}") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done
	osascript -e "tell application \"Alfred 2\" to run trigger \"query\" in workflow \"florian.shows\" with argument \"$name \""

# case "m" for magnet
elif [[ $case_letter == "m" ]] ; then
	# find and kill any instance of peerflix & VLC we're responsible for
	if [[ -f ${PEERFLIX_PID} ]] && kill -0 $(cat "${PEERFLIX_PID}"); then

		# find VLC instance attached to the peerflix instance
		PLAYER_PID=$(findmyson $(cat "${PEERFLIX_PID}"))

		# send kill signals
		if [[ $PLAYER_PID -gt 0 ]]; then kill -9 $PLAYER_PID; fi
		kill -9 $(cat "${PEERFLIX_PID}")

		# wait for killing to be over
		if [[ $PLAYER_PID -gt 0 ]]; then while kill -0 $PLAYER_PID; do :; done; fi
		while kill -0 $(cat "${PEERFLIX_PID}"); do :; done

		# remove PID file
		rm "${PEERFLIX_PID}"
	fi

	echo "$case_letter$QUERY"

fi
#!/bin/bash
export PATH=$PATH:/usr/local/bin

bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
data=${HOME}/Library/Application\ Support/Alfred\ 2/Workflow\ Data/${bundle}
PEERFLIX_PID="${cache}/peerflix.pid"
PLAYER_PID="${cache}/player.pid"
NODE_PID="${cache}/node.pid"
NODE_PORT="${cache}/node.port"
init=$(date +%s);

QUERY="$1"
case_letter=${QUERY:0:1}
QUERY=${QUERY:1}

function start_server {
	# kickoff server if it isn't running
	if [[ ! -f ${NODE_PID} ]] || ( ! ps -p $(cat "${NODE_PID}") > /dev/null ); then
		# find port
		found=0; port=9000
		while [ $found -eq 0 ]; do
			let port=port+1
			if [[ ! "$(netstat -aln | awk '$6 == "LISTEN" && $4 ~ "port$"')" ]]; then found=1; fi
		done
		# launch server
		nohup ${node} ./server.js 127.0.0.1:$port &> "${cache}/node-out.txt" &
		# and store
		echo $! > "${NODE_PID}"
		echo $port > "${NODE_PORT}"
	else
		port=$(cat "${NODE_PORT}")
	fi
	echo $port
}
function isthismydad {
	parent=$(ps -p ${1:-$$} -o ppid=)
	if [ $parent -eq $2 ]; then
		echo 0
	elif [ $parent -eq 0 ]; then
		echo 1
	else
		echo $(isthismydad $parent $2)
	fi
}
function findmyson {
	if hash mpv 2> /dev/null; then
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
function killpeerflixandplayer {
	# find and kill any instance of peerflix & player we're responsible for
	if [[ -f ${PLAYER_PID} ]] && kill -0 $(cat "${PLAYER_PID}"); then
		kill -9 $(cat "${PLAYER_PID}")
		while kill -0 $(cat "${PLAYER_PID}"); do :; done
		rm "${PLAYER_PID}"
	fi
	if [[ -f ${PEERFLIX_PID} ]] && kill -0 $(cat "${PEERFLIX_PID}"); then
		# find player instance attached to the peerflix instance
		player_pid_nb=$(findmyson $(cat "${PEERFLIX_PID}"))

		# send kill signals
		if [[ $player_pid_nb -gt 0 ]]; then kill -9 $player_pid_nb; fi
		kill -9 $(cat "${PEERFLIX_PID}")

		# wait for killing to be over
		if [[ $player_pid_nb -gt 0 ]]; then while kill -0 $player_pid_nb; do :; done; fi
		while kill -0 $(cat "${PEERFLIX_PID}"); do :; done

		# remove PID file
		rm "${PEERFLIX_PID}"
	fi
}


# case "l" (originally) for large-type
if [[ $case_letter == "l" ]] ; then
	id=$(echo $QUERY| cut -d " " -f1)
	name=${QUERY:${#id}}
	(qlmanage -p "${data}/summaries/$id.rtf"; osascript -e "tell application \"Alfred 2\" to run trigger \"query\" in workflow \"florian.shows\" with argument \"$name \"")

# case "f" for favorite
elif [[ $case_letter == "f" ]] ; then
	port=$(start_server)
	id=$(echo $QUERY| cut -d " " -f1)
	name=${QUERY:${#id}}
	until out=$(curl 127.0.0.1:$port -s -d "fav=${id:1}" -d "bool=${id:0:1}") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done
	osascript -e "tell application \"Alfred 2\" to run trigger \"query\" in workflow \"florian.shows\" with argument \"$name \""

# case "c" for current
elif [[ $case_letter == "c" ]] ; then
	killpeerflixandplayer


# case "w" for watched
elif [[ $case_letter == "w" ]] ; then
	port=$(start_server)
	sub_case_letter=${QUERY:0:1}
	QUERY=${QUERY:1}
	id=$(echo $QUERY| cut -d " " -f1)
	if [[ $sub_case_letter == "f" ]] ; then #case "f" for full
		name=${QUERY:$[${#id}+1]}
		until out=$(curl 127.0.0.1:$port -s -d "mark_watched=$id") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done
	elif [[ $sub_case_letter == "s" ]]; then #case "s" for specific
		season=$(echo $QUERY| cut -d " " -f2)
		episode=$(echo $QUERY| cut -d " " -f3)
		name=${QUERY:$[${#id}+${#season}+${#episode}]+3}
		until out=$(curl 127.0.0.1:$port -s -d "mark_watched=$id" -d "season=$season" -d "episode=$episode") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done
	fi
	osascript -e "tell application \"Alfred 2\" to run trigger \"query\" in workflow \"florian.shows\" with argument \"$name \""

# case "m" for magnet
elif [[ $case_letter == "m" ]] ; then
	port=$(start_server)
	killpeerflixandplayer

	printf "$case_letter$QUERY"

fi
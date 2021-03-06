#!/bin/bash
export PATH=$PATH:/usr/local/bin

bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
data=${HOME}/Library/Application\ Support/Alfred\ 2/Workflow\ Data/${bundle}
PEERFLIX_PID="${cache}/peerflix.pid"
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

# case "l" (originally) for large-type (default)
if [[ $case_letter == "l" ]] ; then
	./handler.sh "l$QUERY"

# case "f" for favorite (default)
elif [[ $case_letter == "f" ]] ; then
	./handler.sh "f$QUERY"

# case "c" for current
elif [[ $case_letter == "c" ]] ; then
	port=$(start_server)
	id=$(echo $QUERY| cut -d " " -f1)
	season=$(echo $QUERY| cut -d " " -f2)
	episode=$(echo $QUERY| cut -d " " -f3)
	title=${QUERY:$[${#id}+${#season}+${#episode}]+3}

	terminal-notifier -title "Downloading torrent..." -message "$title" -sender com.runningwithcrayons.Alfred-2 -contentImage "${data}/imgs/$id.jpg"

	# get magnet
	until magnet=$(curl 127.0.0.1:$port -s -d "magnet_id=$id" -d "season=$season" -d "episode=$episode") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done
	open -g "$magnet"

	killpeerflixandplayer

	until out=$(curl 127.0.0.1:$port -s -d "mark_watched=$id" -d "season=$season" -d "episode=$episode") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done

# case "w" for watched (default)
elif [[ $case_letter == "w" ]] ; then
	./handler.sh "w$QUERY"

# case "m" for magnet (default with progress=0)
elif [[ $case_letter == "m" ]] ; then
	port=$(start_server)

	id=$(echo $QUERY| cut -d " " -f1)
	season=$(echo $QUERY| cut -d " " -f2)
	episode=$(echo $QUERY| cut -d " " -f3)
	progress=$(echo $QUERY| cut -d " " -f4)
	title=${QUERY:$[${#id}+${#progress}+${#season}+${#episode}]+4}

	terminal-notifier -title "Downloading torrent..." -message "$title" -sender com.runningwithcrayons.Alfred-2 -contentImage "${data}/imgs/$id.jpg"

	# get magnet
	until magnet=$(curl 127.0.0.1:$port -s -d "magnet_id=$id" -d "season=$season" -d "episode=$episode") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done
	open -g "$magnet"

fi
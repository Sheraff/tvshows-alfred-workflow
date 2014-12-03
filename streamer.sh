#!/bin/bash
export PATH=$PATH:/usr/local/bin

bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
data=${HOME}/Library/Application\ Support/Alfred\ 2/Workflow\ Data/${bundle}
episodes="${cache}/episodes/"
PEERFLIX_PID="${cache}/peerflix.pid"
PLAYER_PID="${cache}/player.pid"
NEXT_EP_HOST="${cache}/next_ep_host.txt"
NODE_PID="${cache}/node.pid"
init=$(date +%s);

QUERY=$1
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
	start_server

	# parsing input
	id=$(echo $QUERY| cut -d " " -f1)
	season=$(echo $QUERY| cut -d " " -f2)
	episode=$(echo $QUERY| cut -d " " -f3)
	progress=$(echo $QUERY| cut -d " " -f4)
	title=${QUERY:$[${#id}+${#progress}+${#season}+${#episode}]+4}

	# is this ep pre loaded?
	is_pre_loaded=0
	if [[ -f ${NEXT_EP_HOST} ]]; then
		next_ep_host_info=$(cat "${NEXT_EP_HOST}")
		next_ep_peerflix_pid=$(echo $next_ep_host_info| cut -d " " -f1)
		next_ep_host_id=$(echo $next_ep_host_info| cut -d " " -f2)
		next_ep_host_season=$(echo $next_ep_host_info| cut -d " " -f3)
		next_ep_host_episode=$(echo $next_ep_host_info| cut -d " " -f4)
		next_ep_host_magnet=$(echo $next_ep_host_info| cut -d " " -f5)
		next_ep_host_url=$(echo $next_ep_host_info| cut -d " " -f6)

		if kill -0 $next_ep_peerflix_pid && [[ $id -eq $next_ep_host_id ]] && [[ $season -eq $next_ep_host_season ]] && [[ $episode -eq $next_ep_host_episode ]]; then
			is_pre_loaded=1

			# use existing peerflix
			if hash mpv 2> /dev/null; then
				nohup mpv --ontop --really-quiet --loop=no --start=$progress --input-unix-socket=socket.io --title="$title" $next_ep_host_url &
				player="mpv"
			else
				nohup /Applications/VLC.app/Contents/MacOS/VLC -q --video-on-top -I macosx --start-time $progress --extraintf oldrc --extraintf rc --rc-host http://127.0.0.1:8376 --meta-title "$title" --play-and-exit $next_ep_host_url &
				player="VLC"
			fi
			echo $! > "${PLAYER_PID}"
			echo $next_ep_peerflix_pid > "${PEERFLIX_PID}"

			# create secondary peerflix to trigger "on-downloaded" event
			nohup node ./node_modules/peerflix/app.js "$next_ep_host_magnet" -q -f "${episodes}" --on-downloaded "nohup ./pre_dl_ep.sh $id $season $episode" &
		fi
	fi

	if [[ $is_pre_loaded -eq 0 ]]; then

		# send notification
		terminal-notifier -title "Loading torrent..." -message "$title" -sender com.runningwithcrayons.Alfred-2 -contentImage "${data}/imgs/$id.jpg"

		# get magnet
		until magnet=$(curl 127.0.0.1:8374 -s -d "magnet_id=$id" -d "season=$season" -d "episode=$episode") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done

		# wait for previous peerflix to die
		if [[ -f ${PEERFLIX_PID} ]] && kill -0 $(cat "${PEERFLIX_PID}"); then
			while kill -0 $(cat "${PEERFLIX_PID}"); do :; done
		fi

		# start peerflix
		if hash mpv 2> /dev/null; then
			nohup node ./node_modules/peerflix/app.js "$magnet" --hostname 127.0.0.1 -q -f "${episodes}" --on-downloaded "nohup ./pre_dl_ep.sh $id $season $episode" -k -- --start=$progress --input-unix-socket=socket.io --title="\"$title\"" &
			player="mpv"
		else
			nohup node ./node_modules/peerflix/app.js "$magnet" --hostname 127.0.0.1 -q -f "${episodes}" --on-downloaded "nohup ./pre_dl_ep.sh $id $season $episode" -v -- -I macosx --start-time $progress --extraintf oldrc --extraintf rc --rc-host http://127.0.0.1:8376 --meta-title "\"$title\"" --play-and-exit &
			player="VLC"
		fi
		echo $! > "${PEERFLIX_PID}"

		# kill secondary peerflix
		if [[ -f ${NEXT_EP_HOST} ]]; then
			next_ep_host_info=$(cat "${NEXT_EP_HOST}")
			next_ep_peerflix_pid=$(echo $next_ep_host_info| cut -d " " -f1)
			if kill -0 $next_ep_peerflix_pid; then
				kill -9 $next_ep_peerflix_pid
				while kill -0 $next_ep_peerflix_pid; do :; done
			fi
			rm "$NEXT_EP_HOST"
		fi
	fi


	# wait for server response (in case node isn't done launching yet)
	until out=$(curl 127.0.0.1:8374 -s -d "stream=$title" -d "show_id=$id" -d "player=$player") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done
	echo " "

fi
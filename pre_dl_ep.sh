#!/bin/bash
export PATH=$PATH:/usr/local/bin

bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
data=${HOME}/Library/Application\ Support/Alfred\ 2/Workflow\ Data/${bundle}
episodes="${cache}/episodes/"
PEERFLIX_PID="${cache}/peerflix.pid"
NEXT_EP_HOST="${cache}/next_ep_host.txt"
NODE_PID="${cache}/node.pid"
init=$(date +%s);

# ask for next ep's magnet
magnet=$(curl 127.0.0.1:8374 -s -d "next_magnet_id=$1" -d "season=$2" -d "episode=$3")

id=$(echo $magnet| cut -d " " -f1)
season=$(echo $magnet| cut -d " " -f2)
episode=$(echo $magnet| cut -d " " -f3)
magnet=$(echo $magnet| cut -d " " -f4)

# remember to kill peerflix that launched this very script if it's not the one being used right now
peerflix_to_kill_pid=0
if [[ -f ${NEXT_EP_HOST} ]]; then
	next_ep_host_info=$(cat "${NEXT_EP_HOST}")
	next_ep_peerflix_pid=$(echo $next_ep_host_info| cut -d " " -f1)
	if kill -0 $next_ep_peerflix_pid && [[ $next_ep_peerflix_pid -eq $(cat "${PEERFLIX_PID}") ]]; then
		peerflix_to_kill_pid=$(ps -o ppid= $$)
		rm "$NEXT_EP_HOST"
	fi
fi

# start downloading it
nohup node ./node_modules/peerflix/app.js "$magnet" --hostname 127.0.0.1 -q -f "${episodes}" --on-listening "./log_pre_dl_ep_host.sh $id $season $episode \"$magnet\"" &

# actually kill secondary peerflix
if [[ $peerflix_to_kill_pid -gt 0 ]]; then
	kill -9 $peerflix_to_kill_pid
fi
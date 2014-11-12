#!/bin/bash
export PATH=$PATH:/usr/local/bin

bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
data=${HOME}/Library/Application\ Support/Alfred\ 2/Workflow\ Data/${bundle}
episodes="${cache}/episodes/"
SECONDARY_PEERFLIX_PID="${cache}/secondary_peerflix.pid"
NODE_PID="${cache}/node.pid"
init=$(date +%s);

# ask for next ep's magnet
magnet=$(curl 127.0.0.1:8374 -s -d "next_magnet_id=$1" -d "season=$2" -d "episode=$3")

id=$(echo $magnet| cut -d " " -f1)
season=$(echo $magnet| cut -d " " -f2)
episode=$(echo $magnet| cut -d " " -f3)
magnet=$(echo $magnet| cut -d " " -f4)

# remember to kill previous secondary peerflix
peerflix_to_kill_pid=0
if [[ -f ${SECONDARY_PEERFLIX_PID} ]] && kill -0 $(cat "${SECONDARY_PEERFLIX_PID}"); then
	peerflix_to_kill_pid=$(cat "${SECONDARY_PEERFLIX_PID}")
fi

# start downloading it
nohup node ./node_modules/peerflix/app.js "$magnet" -q -f "${episodes}" --on-listening "./log_pre_dl_ep_host.sh $id $season $episode \"$magnet\"" &
echo $! > "${SECONDARY_PEERFLIX_PID}"

# actually kill previous secondary peerflix
if [[ $peerflix_to_kill_pid -gt 0 ]]; then
	kill -9 $peerflix_to_kill_pid
fi
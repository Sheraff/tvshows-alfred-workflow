#!/bin/bash
export PATH=/usr/local/bin:$PATH
QUERY="$1"
bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
data=${HOME}/Library/Application\ Support/Alfred\ 2/Workflow\ Data/${bundle}
NODE_PID="${cache}/node.pid"
node="/usr/local/bin/node"
init=$(date +%s);


# make the directories if they don't exit
[[ ! -d "${cache}" ]] && mkdir -p "${cache}"
[[ ! -d "${data}" ]] && mkdir -p "${data}"

# kickoff server if it isn't running
if [[ ! -f ${NODE_PID} ]] || ( ! ps -p $(cat "${NODE_PID}") > /dev/null ); then
	# launch server
	nohup ${node} ./server.js 127.0.0.1:8374 &> "${cache}/node-out.txt" &
	# and store NODE_PID
	echo $! > "${NODE_PID}"
fi

# wait for server response
until out=$(curl 127.0.0.1:8374 -s -d "query=$QUERY") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done

# echo to alfred
echo "$out"
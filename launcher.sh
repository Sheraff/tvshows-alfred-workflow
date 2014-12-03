#!/bin/bash
export PATH=/usr/local/bin:$PATH
QUERY="$1"
bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
data=${HOME}/Library/Application\ Support/Alfred\ 2/Workflow\ Data/${bundle}
NODE_PID="${cache}/node.pid"
NODE_PORT="${cache}/node.port"
node="/usr/local/bin/node"
init=$(date +%s);


# make the directories if they don't exit
[[ ! -d "${cache}" ]] && mkdir -p "${cache}"
[[ ! -d "${data}" ]] && mkdir -p "${data}"

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

# wait for server response
until out=$(curl 127.0.0.1:$port -s -d "query=$QUERY") || [[ $(($(date +%s)-init)) -gt 10 ]]; do :; done

# echo to alfred
echo "$out"
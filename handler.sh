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
	id=$(echo $QUERY| cut -d " " -f1)
	name=${QUERY:${#id}}
	(qlmanage -p "${cache}/summaries/$id.rtf"; osascript -e "tell application \"Alfred 2\" to run trigger \"query\" in workflow \"florian.shows\" with argument \"$name \"")

# case "f" for favorite
elif [[ $case_letter == "f" ]] ; then
	start_server
	id=$(echo $QUERY| cut -d " " -f1)
	name=${QUERY:${#id}}
	until out=$(curl 127.0.0.1:8374 -s -d "fav=${id:1}" -d "bool=${id:0:1}"); do :; done
	osascript -e "tell application \"Alfred 2\" to run trigger \"query\" in workflow \"florian.shows\" with argument \"$name \""

# case "m" for magnet
elif [[ $case_letter == "m" ]] ; then
	# remove existing instances of peerflix & vlc (that we're responsible for)
	if [[ -f ${PEERFLIX_PID} ]] && kill -0 $(cat "${PEERFLIX_PID}"); then kill -9 $(cat "${PEERFLIX_PID}"); fi
	if [[ -f ${VLC_PID} ]] && kill -0 $(cat "${VLC_PID}"); then kill -9 $(cat "${VLC_PID}"); fi

	if [[ -f ${PEERFLIX_PID} ]] && kill -0 $(cat "${PEERFLIX_PID}"); then
		while kill -0 $(cat "${PEERFLIX_PID}"); do :; done
	fi
	if [[ -f ${VLC_PID} ]] && kill -0 $(cat "${VLC_PID}"); then
		while kill -0 $(cat "${VLC_PID}"); do :; done
	fi
	if [[ -f ${PEERFLIX_PID} ]]; then rm "${PEERFLIX_PID}"; fi
	if [[ -f ${VLC_PID} ]]; then rm -f "${VLC}"; fi

	echo "$case_letter$QUERY"

fi
#!/bin/bash

QUERY="$1"
case_letter=${QUERY:0:1}
QUERY=${QUERY:1}

# case "l" (originally) for large-type (default)
if [[ $case_letter == "l" ]] ; then
	./handler.sh "l$QUERY"

# case "f" for favorite (default)
elif [[ $case_letter == "f" ]] ; then
	./handler.sh "f$QUERY"

# case "m" for magnet (default with progress=0)
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

	id=$(echo $QUERY| cut -d " " -f1)
	progress=$(echo ${QUERY:${#id}}| cut -d " " -f1)
	magnet=$(echo ${QUERY:$[${#progress}+${#id}]+2}| cut -d " " -f1)
	title=${QUERY:$[${#magnet}+${#progress}+${#id}]+3}

	echo "m$id 0 $magnet $title"

fi
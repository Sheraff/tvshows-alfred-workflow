#!/bin/bash
export PATH=$PATH:/usr/local/bin
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

	id=$(echo $QUERY| cut -d " " -f1)
	progress=$(echo ${QUERY:${#id}}| cut -d " " -f1)
	magnet=$(echo ${QUERY:$[${#progress}+${#id}]+2}| cut -d " " -f1)
	title=${QUERY:$[${#magnet}+${#progress}+${#id}]+3}

	bundle="florian.shows"
	cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}

	open -g "$magnet"
	terminal-notifier -title "Downloading torrent..." -message "$title" -sender com.runningwithcrayons.Alfred-2 -contentImage "${cache}/imgs/$id.jpg"

fi
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

# case "w" for watched (default)
elif [[ $case_letter == "w" ]] ; then
	./handler.sh "w$QUERY"

# case "m" for magnet (default with progress=0)
elif [[ $case_letter == "m" ]] ; then

	id=$(echo $QUERY| cut -d " " -f1)
	progress=$(echo ${QUERY:${#id}}| cut -d " " -f1)
	magnet=$(echo ${QUERY:$[${#progress}+${#id}]+2}| cut -d " " -f1)
	title=${QUERY:$[${#magnet}+${#progress}+${#id}]+3}

	bundle="florian.shows"
	data=${HOME}/Library/Application\ Support/Alfred\ 2/Workflow\ Data/${bundle}

	open -g "$magnet"
	terminal-notifier -title "Downloading torrent..." -message "$title" -sender com.runningwithcrayons.Alfred-2 -contentImage "${data}/imgs/$id.jpg"

fi
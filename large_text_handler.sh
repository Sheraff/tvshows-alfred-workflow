QUERY="l61056"
if [[ ${QUERY:0:1} == "l" ]] ; then
	bundle="florian.shows"
	cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}/summaries
	qlmanage -p "${cache}/${QUERY:1}.rtf" &
fi
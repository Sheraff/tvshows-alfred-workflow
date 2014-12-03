#!/bin/bash
export PATH=$PATH:/usr/local/bin

bundle="florian.shows"
cache=${HOME}/Library/Caches/com.runningwithcrayons.Alfred-2/Workflow\ Data/${bundle}
NEXT_EP_HOST="${cache}/next_ep_host.txt"
parent=$(ps -o ppid= $$)

echo "$parent $1 $2 $3 $4 $5" > "$NEXT_EP_HOST"
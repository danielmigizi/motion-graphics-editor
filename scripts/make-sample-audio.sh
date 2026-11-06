#!/usr/bin/env bash
# Synthesise the sample project's music bed and whoosh into public/assets/
# with ffmpeg alone: a soft five-note sine pad (24 s, 48 kHz stereo) and a
# 20-frame whoosh (pink noise plus a falling chirp, sharp attack). No recorded
# or third-party material, so both files are original by construction.
#
#   bash scripts/make-sample-audio.sh [out-dir]   (default: public/assets)
set -euo pipefail
out="${1:-public/assets}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"

ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

pad_l="sin(2*PI*146.83*t)*(0.85+0.15*sin(2*PI*0.11*t)) + sin(2*PI*220.00*t)*(0.85+0.15*sin(2*PI*0.17*t+1)) + sin(2*PI*329.63*t)*(0.8+0.2*sin(2*PI*0.13*t+2)) + 0.8*sin(2*PI*369.99*t)*(0.8+0.2*sin(2*PI*0.09*t+3)) + 0.5*sin(2*PI*554.37*t)*(0.7+0.3*sin(2*PI*0.07*t))"
pad_r="sin(2*PI*147.13*t)*(0.85+0.15*sin(2*PI*0.12*t+0.5)) + sin(2*PI*220.35*t)*(0.85+0.15*sin(2*PI*0.16*t+2)) + sin(2*PI*329.93*t)*(0.8+0.2*sin(2*PI*0.14*t+1)) + 0.8*sin(2*PI*370.30*t)*(0.8+0.2*sin(2*PI*0.1*t)) + 0.5*sin(2*PI*554.70*t)*(0.7+0.3*sin(2*PI*0.08*t+1))"
ff -f lavfi -i "aevalsrc='0.062*(${pad_l})|0.062*(${pad_r})':s=48000:d=24,lowpass=f=2500,afade=t=in:d=1.0,afade=t=out:st=22.5:d=1.5" -c:a pcm_s16le "$tmp/bed.wav"
ff -i "$tmp/bed.wav" -af volume=3.16dB -c:a pcm_s16le "$out/music-bed.wav"

ff -f lavfi -i "anoisesrc=d=0.6667:c=pink:r=48000:a=0.9:seed=41" \
   -f lavfi -i "aevalsrc='0.35*sin(2*PI*(900*t-600*t*t))':s=48000:d=0.6667" \
   -filter_complex "[0]highpass=f=500,lowpass=f=7000[n];[n][1]amix=inputs=2:normalize=0,aeval='val(0)*min(1,t/0.0015)*exp(-6*t)*(1-min(1,max(0,(t-0.55)/0.1167)))':c=same,pan=stereo|c0=c0|c1=c0" \
   -ar 48000 -c:a pcm_s16le "$tmp/whoosh.wav"
ff -i "$tmp/whoosh.wav" -af volume=3.5dB -c:a pcm_s16le "$out/whoosh.wav"

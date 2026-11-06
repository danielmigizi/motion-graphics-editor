// Every host wraps the composition in this: root frame, config, environment,
// readiness, media components, and (native hosts) playback, audio and the
// exporter's video frames and media reports.

import React, { useMemo } from 'react';
import { DelayContext, EnvironmentContext, MediaContext, TimelineContext, VideoConfigContext, type Delay, type Environment, type MediaComponents, type VideoConfig } from './context';
import { AudioRegistryContext, MediaReportContext, PlaybackContext, VideoFramesContext, type AudioRegistry, type MediaReports, type Playback, type VideoFrames } from './hostContext';

const STOPPED: Playback = { playing: false, muted: false };

export const RuntimeRoot: React.FC<{
  frame: number;
  config: VideoConfig;
  environment: Environment;
  delay: Delay;
  media: MediaComponents;
  playback?: Playback;
  audio?: AudioRegistry | null;
  videoFrames?: VideoFrames | null;
  reports?: MediaReports | null;
  children: React.ReactNode;
}> = ({ frame, config, environment, delay, media, playback = STOPPED, audio = null, videoFrames = null, reports = null, children }) => {
  const timeline = useMemo(() => ({ frame, offset: 0 }), [frame]);
  return (
    <VideoConfigContext.Provider value={config}>
      <EnvironmentContext.Provider value={environment}>
        <DelayContext.Provider value={delay}>
          <MediaContext.Provider value={media}>
            <PlaybackContext.Provider value={playback}>
              <AudioRegistryContext.Provider value={audio}>
                <VideoFramesContext.Provider value={videoFrames}>
                  <MediaReportContext.Provider value={reports}>
                    <TimelineContext.Provider value={timeline}>{children}</TimelineContext.Provider>
                  </MediaReportContext.Provider>
                </VideoFramesContext.Provider>
              </AudioRegistryContext.Provider>
            </PlaybackContext.Provider>
          </MediaContext.Provider>
        </DelayContext.Provider>
      </EnvironmentContext.Provider>
    </VideoConfigContext.Provider>
  );
};

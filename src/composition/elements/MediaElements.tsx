import React, { useState } from 'react';
import { Img } from '../../runtime';
import { assetUrl, findAsset, MissingAsset, prop, type ElementRenderer } from './shared';

/** <Img> (render waits for load) that degrades to the placeholder if the file cannot be loaded. */
const AssetImg: React.FC<{ src: string; fit: string; width: number; height: number; radius?: number }> = ({
  src,
  fit,
  width,
  height,
  radius,
}) => {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) return <MissingAsset width={width} height={height} radius={radius} />;
  return (
    <Img
      src={src}
      onError={() => setFailedSrc(src)}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        objectFit: fit === 'cover' ? 'cover' : 'contain',
      }}
    />
  );
};

export const LogoElement: ElementRenderer = ({ element, width, height, assets, assetBaseUrl }) => {
  const asset = findAsset(assets, element.props.assetId, ['svg']);
  const fit = prop<string>(element, 'logo', 'fit');
  if (!asset) return <MissingAsset width={width} height={height} />;
  return <AssetImg src={assetUrl(asset, assetBaseUrl)} fit={fit} width={width} height={height} />;
};

export const ImageElement: ElementRenderer = ({ element, width, height, assets, assetBaseUrl }) => {
  const asset = findAsset(assets, element.props.assetId, ['image', 'svg']);
  const fit = prop<string>(element, 'image', 'fit');
  const radius = Math.max(0, prop<number>(element, 'image', 'cornerRadius'));
  const shadow = prop<boolean>(element, 'image', 'shadow');
  if (!asset) return <MissingAsset width={width} height={height} radius={radius} />;
  const unit = Math.max(width, height) / 1000;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        borderRadius: radius,
        overflow: 'hidden',
        boxShadow: shadow
          ? `0 ${48 * unit}px ${120 * unit}px rgba(2, 6, 23, 0.55), 0 ${10 * unit}px ${28 * unit}px rgba(2, 6, 23, 0.35)`
          : undefined,
        // Hairline edge so a dark image still separates from a dark scene.
        outline: shadow ? '1px solid rgba(255, 255, 255, 0.08)' : undefined,
        outlineOffset: -1,
      }}
    >
      <AssetImg src={assetUrl(asset, assetBaseUrl)} fit={fit} width={width} height={height} radius={radius} />
    </div>
  );
};

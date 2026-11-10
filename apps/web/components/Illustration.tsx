const illustrationSizes = {
  landing: { width: 1651, height: 953 },
  pricing: { width: 1651, height: 953 },
  privacy: { width: 1651, height: 953 },
  terms: { width: 1651, height: 953 },
};

export type IllustrationName = keyof typeof illustrationSizes;

/**
 * Decorative Ragis drawings (public/illustrations/ragis-*.svg).
 * CSS selects the palette that matches the theme, as it does for FileTile icons.
 */
export function Illustration({ name, className }: { name: IllustrationName; className?: string }) {
  const { width, height } = illustrationSizes[name];
  const src = `/illustrations/ragis-${name}`;
  return (
    <span className={className ? `ill ${className}` : "ill"} aria-hidden="true">
      <img className="ill-light" src={`${src}.svg`} width={width} height={height} alt="" loading="lazy" decoding="async" />
      <img className="ill-dark" src={`${src}-dark.svg`} width={width} height={height} alt="" loading="lazy" decoding="async" />
    </span>
  );
}

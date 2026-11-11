import { useCallback, useState } from "react";

interface FadeImgProps {
  src: string;
  className: string;
  alt?: string;
  lazy?: boolean;
  onError?: () => void;
}

/** An image that fades in once it has loaded, instead of painting in strips. */
export function FadeImg({ src, className, alt = "", lazy, onError }: FadeImgProps) {
  const [loaded, setLoaded] = useState<string | null>(null);
  // Images already in the browser's cache can be complete before `load` is heard.
  const ref = useCallback(
    (el: HTMLImageElement | null) => {
      if (el?.complete && el.naturalWidth > 0) setLoaded(src);
    },
    [src],
  );
  return (
    <img
      ref={ref}
      className={`${className} fade-img${loaded === src ? " is-loaded" : ""}`}
      src={src}
      alt={alt}
      decoding="async"
      {...(lazy && { loading: "lazy" as const })}
      onLoad={() => setLoaded(src)}
      {...(onError && { onError })}
    />
  );
}

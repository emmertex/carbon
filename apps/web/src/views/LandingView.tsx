import { useEffect } from 'react';

/** Legacy in-app apex navigation hands off to the static marketing document. */
export function LandingView() {
  useEffect(() => {
    window.location.replace('/');
  }, []);
  return <a href="/">Open Carbon home</a>;
}

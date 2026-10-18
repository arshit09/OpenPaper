import { defaultResolveUrl, type RenderContext } from '@openpaper/core';

/** URLs resolve against the page origin (the editor is served by, or proxied to, the server). */
export const renderContext: RenderContext = {
  resolveUrl: (src) => defaultResolveUrl(src),
};

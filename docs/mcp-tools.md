# OpenPaper MCP tools

OpenPaper exposes 40 tools, compatible with Paper's MCP server (same names, parameters and response shapes).
Generated from `packages/server/src/tools/definitions.ts` — do not edit by hand.

- **Streamable HTTP:** `http://127.0.0.1:29880/mcp` (while OpenPaper is running)
- **stdio:** `openpaper mcp` (starts OpenPaper in the background when needed)

Every file-scoped tool returns a first text item `{"file":{"id","name"},"contentHash":{"tokens"}}` followed by the result.

## Server instructions

```text
OpenPaper is an open-source design tool for user interfaces. The user works on an infinite 2D canvas where every design is real HTML and CSS.
These tools let you act as a skilled product and web designer: read the user's file, see what they are doing, and write HTML back into the design as editable layers. The user watches your work appear live.

You MUST read the full guide before using the other tools: get_guide({ topic: "paper-mcp-instructions" }). Read it once per session, and again if a long conversation may have lost it.

- Begin with get_basic_info for the file's pages, artboards, sizes and tokens, and get_selection for whatever the user has selected. Without a fileId, tools act on the file the user has open; list_resources finds the others.
- Tools default to the page on the user's screen. A pageId lets you work on another page while they keep their view — you can't change which page they see.
- Typography: call get_font_family_info before your first text styling in a session. Prefer the font families already in get_basic_info unless the user asks otherwise. Use px for font sizes and line heights, em for letter-spacing.
- New designs: before writing HTML, share a short brief (mood, palette, type scale, spacing, direction) unless a design system is given.
- Build in small steps: each write_html call adds about one visual group. duplicate_nodes + update_styles + set_text_content is often faster than writing more HTML.
- Check your work with get_screenshot after meaningful changes. Artboard height is only a starting point: if content clips, set height: "fit-content" with update_styles instead of guessing a new height.
- Repeated rows (lists, nav): give icons and trailing actions fixed-width slots (flexShrink: 0); gap alone won't line up columns across rows.
- ALWAYS call finish_working_on_nodes once your edits are complete.
- Refer to layers by name in your replies; node ids are internal.
- Moving a design into a codebase: use get_jsx, get_computed_styles and get_fill_image for exact values — never read sizes or colors off screenshots.
```

## `open_file`

_App-level · readOnly_

Open an OpenPaper file by id or URL so later calls can target it. pageId only applies when the file is not already open; an open file never switches pages under the user. Returns the same payload as get_basic_info.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fileId` | string | yes | The file to open: a bare file id, a /file/<id> route or an OpenPaper file URL. |
| `pageId` | string |  | Page to show when the file is first opened. Ignored when the file is already open so the user is not pulled away from their page. |

## `list_resources`

_App-level · readOnly_

Lists the files and folders on this computer. Every entry carries its type ("file" | "folder") and, unless it sits at the top level, a parentId. Files that are open in an editor come first — `open` = open in some editor tab, `active` = the tab in front of the user — followed by everything else, newest update first.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer |  | Maximum number of items to return (default 50). |

## `create_file`

_App-level · destructive_

Create a new file and return its id and URL. Call open_file with the returned id to start working in it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cloneFileId` | string |  | Optional id of a file to copy. The new file starts as a copy of it. |
| `name` | string |  | Optional display name for the new file. |

## `rename_resource`

_App-level · destructive_

Renames a file or folder as shown in the file browser. Surrounding whitespace is trimmed and names are capped at 500 characters; an empty name changes nothing. The response echoes the saved name and the resource type.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `resourceId` | string | yes | Id of the file or folder. |
| `name` | string | yes | The new name. |

## `create_page`

_File-scoped · destructive_

Add a page right after the page the user is viewing and return its id (reorder with arrange_pages). The user's view does not change; pass the returned pageId to other tools to work on the new page.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string |  | Display name for the page list. Defaults to "Page N". |
| `icon` | "arrow" \| "padlock" \| "check" \| "cross" \| "info" \| "question" \| "design" \| "vector" \| "images" \| "table" \| "presentation" \| "blueprint" \| "swatches" \| "bar-chart" \| "line-chart" \| "pie-chart" \| "paper" |  | Decorative icon shown in the page list (it does not change page behavior). Notes: arrow: a bold arrow, handy for a starting page; design: a pen nib, for design work; paper: a crumpled sheet, for scraps and junk. |
| `fileId` | string | yes | The file to operate on. |

## `update_pages`

_File-scoped · destructive_

Rename pages and/or change their icons, several at once. Does not change which page the user is viewing.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `updates` | { pageId: string, name?: string, icon?: "arrow" \| "padlock" \| "check" \| "cross" \| "info" \| "question" \| "design" \| "vector" \| "images" \| "table" \| "presentation" \| "blueprint" \| "swatches" \| "bar-chart" \| "line-chart" \| "pie-chart" \| "paper" \| null }[] | yes | One entry per page: the page id plus the fields to change. |
| `fileId` | string | yes | The file to operate on. |

## `arrange_pages`

_File-scoped · destructive_

Reorder the page list and add or remove dividers (visual separators between groups of pages) in one call. Pass the complete new order. If an item is missing, repeated or unknown — which also happens when pages changed since you read the list — the call is rejected and nothing changes. Pages are never deleted and the user stays on their page. Returns the updated page list.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `order` | string \| { type: "divider" }[] | yes | Each page and divider id from get_basic_info, once, in the order you want (leave out dividers you are removing via removeDividerIds). Insert { "type": "divider" } at every spot that should get a new divider. |
| `removeDividerIds` | string[] |  | Ids of existing dividers to remove. |
| `fileId` | string | yes | The file to operate on. |

## `get_basic_info`

_File-scoped (fileId optional) · readOnly_

Essential context about a design: file name, page name, node count, the page's artboards with sizes and canvas positions, the page list, font families in use and a compact list of design tokens. Call this first.
- Without fileId the file the user is viewing is used; without pageId, the page they are viewing.
- worldX/worldY are canvas coordinates. Sizes and positions are null when they depend on layout (fit-content, flex children) that has not been measured.
- pages lists pages (type "page") and dividers (type "divider") in display order. Dividers have no canvas, so their ids can't be used as pageId.
- isActive flags the page currently on the user's screen (this may change mid-task). To work on a different page without moving the user's view, give page-scoped tools (create_artboard, export, get_basic_info) a pageId; node-based tools always operate on the page that contains the node.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pageId` | string |  | The page to operate on. Defaults to the page the user is viewing, which can change between calls — prefer passing explicit page ids. |
| `fileId` | string |  | The file to operate on. Defaults to the file the user is viewing. |

## `get_selection`

_File-scoped (fileId optional) · readOnly_

The nodes the user currently has selected: ids, names, component types, sizes, positions and the artboard each belongs to. Without fileId the file the user is viewing is used.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fileId` | string |  | The file to operate on. Defaults to the file the user is viewing. |

## `get_node_info`

_File-scoped · readOnly_

Details about one node: size, visibility, lock state, parent, child ids, text (Text nodes), canvas position (worldX/worldY) and position inside its parent (x/y).
- Nodes with an AI-generated image also report imageGeneration: status is "processing", "ready" or "error", and output is "raster" or "svg". Call again later to see whether generation is done.
- Text with mixed styles (a bold word, a link) also reports textRuns: the text in order, each part with the inline styles that override the node's own.
- Positions are null when they depend on layout that has not been measured.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Id of the node to inspect. |
| `fileId` | string | yes | The file to operate on. |

## `get_children`

_File-scoped · readOnly_

The direct children of a node: ids, names, component types, how many children each has, canvas position (worldX/worldY) and position inside the parent (x/y).
- Positions are null when they depend on layout that has not been measured.
- Errors if the node does not exist.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Id of the parent node. |
| `fileId` | string | yes | The file to operate on. |

## `get_screenshot`

_File-scoped · readOnly_

Capture a node as an image (base64 JPEG), automatically capped to fit model size limits. The default scale of 1 is enough to check layout, spacing and color; use scale 2 only to read small text or inspect fine detail. For more resolution, capture child nodes instead.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Id of the node to capture. |
| `scale` | number |  | 1 (default) for layout checks; 2 to read small text or fine detail. |
| `animationTime` | number |  | OpenPaper extension: show animations this many milliseconds after they start. Omit for the settled design. |
| `fileId` | string | yes | The file to operate on. |

## `get_jsx`

_File-scoped · readOnly_

JSX for a node and its descendants, styled with Tailwind classes (default, with inline fallbacks) or with inline styles.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Id of the root node. |
| `format` | "tailwind" \| "inline-styles" |  | "tailwind" (default) uses Tailwind classes with inline fallbacks; "inline-styles" uses only inline styles. |
| `includeNodeIds` | boolean |  | Add an id attribute with the node id to every element (default true) so you can target nodes. Pass false when exporting clean code for a codebase. |
| `includeRootPositioning` | boolean |  | Keep the root element's absolute canvas position (position/top/left/right/bottom). Default false, so the JSX is portable. |
| `fileId` | string | yes | The file to operate on. |

## `get_tree_summary`

_File-scoped · readOnly_

A compact, indented outline of a subtree.
- One line per node with its component type, name, id and size; sizes show "?" when they depend on unmeasured layout.
- Far cheaper than get_jsx — use it to orient yourself before reading specific nodes.
- Errors if the node does not exist.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Id of the root node. |
| `depth` | number |  | How many levels to show (default 3, max 10). Deeper nodes appear as a child count. |
| `fileId` | string | yes | The file to operate on. |

## `get_computed_styles`

_File-scoped · readOnly_

The CSS of one or more nodes as a map of nodeId → camelCase style object. Use it for exact values when writing code. Values bound to design tokens appear as var(--token-name).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodeIds` | string[] | yes | Ids of the nodes to read. |
| `fileId` | string | yes | The file to operate on. |

## `get_fill_image`

_File-scoped · readOnly_

Returns a node's image fill as a base64 JPEG (downscaled to stay within API limits) plus metadata including the source URL of the full-resolution file. A missing node is an error; nodes without an image fill, SVG nodes (read those with get_jsx) and images still being generated return an explanatory message instead.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Id of the node with the image fill. |
| `fileId` | string | yes | The file to operate on. |

## `find_nodes`

_File-scoped · readOnly_

Search for nodes by style, by text, or both — handy for locating every use of a color, token or phrase before changing them all. The whole file is searched unless you narrow it with pageId (a single page) or nodeId (a node plus its descendants; takes precedence over pageId). Pass `filters`, `textValue`, or both (all must match). Filters are { styleName, styleValue }: names are case-insensitive and dash-insensitive (background-color = backgroundColor); values are case-insensitive with `*` as a wildcard anchored to the whole value ("8px", "var(--color-*)", "*Inter*"). Color values match the same color in any notation, colors inside compound values, and color tokens that resolve to it. Returns up to 200 nodes with what matched.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pageId` | string |  | Search only this page. Omit (with nodeId) to search every page. |
| `nodeId` | string |  | Search this node and its descendants. Takes priority over pageId. |
| `textValue` | string |  | Match Text node content (case-insensitive; "*" wildcard anchored to the whole text, e.g. "*sign up*"). |
| `filters` | { styleName?: string, styleValue?: string }[] |  | Style matchers that must all match. |
| `fileId` | string | yes | The file to operate on. |

## `list_comment_threads`

_File-scoped · readOnly_

Summaries of the comment threads in this file. Each thread is attached to a node and consists of an opening message and its replies; its status is "open" or "resolved". By default only open threads are returned. Fetch a whole conversation with get_comment_thread, and once the design addresses a thread's feedback, mark it resolved with set_comment_thread_status.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pageId` | string |  | Only threads on this page. Omit for all pages. |
| `currentPageOnly` | boolean |  | Only threads on the user's current page. Ignored when pageId is given. |
| `nodeId` | string |  | Only threads pinned to this node. |
| `status` | "open" \| "resolved" \| "all" |  | Default "open" (threads still needing action). "resolved" or "all" for others. |
| `search` | string |  | Case-insensitive search over author names and message text. |
| `searchScope` | "first-message" \| "all-messages" |  | Search only first messages, or all messages (default). |
| `participantUserId` | string |  | Only threads where this user wrote a message. "current-user" means the person using OpenPaper. |
| `threadAuthorUserId` | string |  | Only threads started by this user. "current-user" means the person using OpenPaper. |
| `sortField` | "page" \| "createdAt" \| "updatedAt" |  | Sort key (default "page", like the comments panel). |
| `sortDirection` | "asc" \| "desc" |  | Sort direction (default "asc"). |
| `limit` | integer |  | Maximum threads to return (default 50). |
| `offset` | integer |  | Matching threads to skip (default 0). |
| `previewLength` | integer |  | Maximum characters of each first-message preview (default 240). |
| `fileId` | string | yes | The file to operate on. |

## `get_comment_thread`

_File-scoped · readOnly_

Full details of one comment thread: status, every message with reactions and attachments, the page and the pinned node. Works for any status. Use list_comment_threads first to find thread ids.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `commentThreadId` | string | yes | Id of the comment thread. |
| `fileId` | string | yes | The file to operate on. |

## `list_comment_thread_authors`

_File-scoped · readOnly_

People who have commented in this file (opened a thread or replied), each with userId, display name, how many threads and messages they wrote and when they were last active. Use it to look up the userId behind a name for list_comment_threads filters.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pageId` | string |  | Only count activity on this page. Omit for all pages. |
| `fileId` | string | yes | The file to operate on. |

## `set_comment_thread_status`

_File-scoped · destructive_

Mark a comment thread "resolved" once its feedback is fully addressed in the design, or "open" to reopen it if more work is needed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `commentThreadId` | string | yes | Id of the comment thread. |
| `status` | "open" \| "resolved" | yes | "resolved" when addressed, "open" to reopen. |
| `fileId` | string | yes | The file to operate on. |

## `get_font_family_info`

_File-scoped · readOnly_

Check whether font families are available (installed on this computer or on Google Fonts) and list every weight and style they offer. Call before your first typographic styling in a session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `familyNames` | string[] | yes | Font family names to look up, e.g. ["Inter", "Fraunces"]. |
| `fileId` | string | yes | The file to operate on. |

## `get_guide`

_App-level · readOnly_

Read a detailed guide. Call with topic "paper-mcp-instructions" before using the other tools for best results. Other topics: "mobile-status-bar", "figma-import", "image-generation", "shaders", "animation".

| Parameter | Type | Required | Description |
|---|---|---|---|
| `topic` | string | yes | Guide to read. Available topics: "paper-mcp-instructions" — How to get the most out of the OpenPaper MCP tools (read this first) "mobile-status-bar" — Ready-to-paste status bar markup for mobile artboards "figma-import" — Workflow for bringing Figma designs into OpenPaper "image-generation" — Generating AI images inside write_html, update_styles and create_artboard with paper-gen:// URLs "shaders" — Shader layers (GPU effects: mesh gradients, grain, dithering, image filters…): the x-shader tag and every effect's parameters (OpenPaper extension) "animation" — Motion: CSS @keyframes animations, video, Lottie and scripted (JavaScript) embed layers, and checking them with screenshots (OpenPaper extension) |

## `export`

_File-scoped · readOnly_

Export nodes to image or PDF files on the user's computer and return the file paths. Unless the user asks for something specific, keep the default export settings.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pageId` | string |  | The page to operate on. Defaults to the page the user is viewing, which can change between calls — prefer passing explicit page ids. |
| `type` | "image" \| "video" |  | Export type (default "image"). |
| `nodes` | "nodes-with-exports-only" \| Record<string, { format: "avif" \| "jpg" \| "mp4" \| "pdf" \| "png" \| "svg" \| "webm" \| "webp", scale: string, durationSeconds?: number, pdfQuality?: "low" \| "medium" \| "high", pdfResampling?: "detailed" \| "basic" }[]> | yes | Either "nodes-with-exports-only" (export every node on the page that has saved export settings) or a map of nodeId → export settings; an empty array uses the node's saved settings or the defaults (PNG at 2x). |
| `fileId` | string | yes | The file to operate on. |

## `export_combined_pdf`

_File-scoped · readOnly_

Combines several nodes into one PDF with a page per node. Pages follow the nodes' placement on the canvas: rows from top to bottom, and left to right within a row. Choose this over export whenever a single combined PDF is wanted.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodeIds` | string[] | yes | Ids of the nodes to combine, one PDF page each. |
| `fileId` | string | yes | The file to operate on. |

## `write_html`

_File-scoped · destructive_

IMPORTANT: work in small steps. The user is watching the canvas while you design, so something new should appear every few seconds.
Each call adds one visible piece — a header, a single list row, a group of buttons or a block of text. Build even a simple card in stages: its frame and heading first, then its rows one by one, then its footer.
IMPORTANT: reuse instead of rewriting. <x-paper-clone node-id="1-0" style="..." /> inserts a copy of an existing node and its children, with any style overrides you add.
For lists and grids, write the container once, then add the items one call at a time — or write the first item and copy it with duplicate_nodes.

Markup rules:
- Styles go in style="..." attributes only.
- Prefer the file's design tokens (CSS variables) wherever they exist.
- font-family accepts any Google Font and any font installed on this computer.
- Colors can use any CSS syntax: hex, rgb/rgba, hsl/hsla, oklch, oklab, …
- Lay out with flexbox — display: flex, padding and gap.
- position: absolute is fine for decoration, but never stretch one absolute element over a whole artboard: it would catch the clicks meant for the layers beneath it.
- Not supported: margin, display: inline, display: grid and <table>. Create space with padding and gap.
- display: block suits leaf elements such as text and shapes; containers should use flex.
- Sizing is always border-box.
- For code or indented text, use <pre> or white-space: pre.
- Icons should be SVG or images, never emoji.
- A text element is one paragraph that wraps as a whole. To style part of it, wrap the words in <span>, <b>, <i>, <u>, <a> or <code> with inline styles, e.g. <p style="font-size:14px">Follow <a style="font-weight:600; text-decoration:underline">@geek updates</a> for more</p>. Spans can change color, font family, size, weight, style, letter-spacing, text decoration, text-transform and background color; line height, alignment and width belong to the whole element. A code sample is one <pre> element.
- Give layers names with the layer-name attribute, e.g. <div layer-name="Hero">.
- Local image files need absolute paper-asset:// URLs, e.g. <img src="paper-asset:///C:/Users/me/logo.svg">.
- paper-gen:// URLs create AI-generated images. Only use them if the user asked for generated imagery, and read get_guide({ topic: "image-generation" }) first.
- OpenPaper extension: <x-shader type="MeshGradient" …> adds a GPU shader layer (animated gradients, grain, dithering, glows, image filters). Read get_guide({ topic: "shaders" }) before using it.
- OpenPaper extension, motion: the animation style plays on the canvas, with @keyframes from a <style> element in the same HTML; <video>, <x-lottie src> and <x-embed> (HTML and JavaScript run in a sandbox) add layers that play. Read get_guide({ topic: "animation" }) before adding motion.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | yes | HTML to turn into design nodes. Standard elements with inline CSS styles (a <style> element may define @keyframes). |
| `targetNodeId` | string | yes | Target node. "insert-children" appends the new nodes inside it; "replace" removes it and puts the new nodes in its place. |
| `mode` | "insert-children" \| "replace" | yes | "insert-children": add the new layers inside the target, after its existing children. "replace": put the new layers where the target was and remove the target. |
| `fileId` | string | yes | The file to operate on. |

## `create_artboard`

_File-scoped · destructive_

Create an artboard (a top-level frame) on the canvas and return its node id; then add content with write_html({ mode: "insert-children" }).
- Set its size and look with styles. Artboards default to display: "flex", flexDirection: "column".
- The artboard is placed in a free spot on the canvas. Pass pageId to create it on a specific page; omit it to use the page the user is viewing.
- A paper-gen:// URL in a style such as backgroundImage produces an AI image; use it only on request, after reading get_guide({ topic: "image-generation" }).
- Unless the user gives a size, use a default device size:
  - Desktop: 1440 × 900px
  - Tablet: 768 × 1024px
  - Mobile: 390 × 844px — start it with a status bar: get_guide({ topic: "mobile-status-bar" }) has paste-ready markup; don't draw one by hand.
The device height is only a starting point to show what fits above the fold. When you finish, if content is clipped, switch the artboard to height: "fit-content" with update_styles instead of guessing another fixed height.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pageId` | string |  | The page to operate on. Defaults to the page the user is viewing, which can change between calls — prefer passing explicit page ids. |
| `name` | string | yes | Artboard name (shown in the layer tree). |
| `styles` | { width: string, height: string } | yes | The artboard's CSS as a camelCase object; width and height (whole pixels) are required. If you choose the position yourself, keep 80px of space between artboards. Example: {"width": "390px", "height": "844px", "display": "flex", "flexDirection": "column", "gap": "16px", "backgroundColor": "#FFFFFF"} |
| `fileId` | string | yes | The file to operate on. |

## `delete_nodes`

_File-scoped · destructive, consequential_

Delete nodes and all of their descendants. IMPORTANT: if you are deleting a node because you think it has the wrong parent, confirm with get_node_info first.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodeIds` | string[] | yes | Ids of the nodes to delete. |
| `fileId` | string | yes | The file to operate on. |

## `set_text_content`

_File-scoped · destructive_

Change the text of one or more Text nodes (component type "Text" only). Use it instead of write_html replace when only the copy changes. Supports batches.
- textContent sets plain text: any mixed styles in the node are removed.
- runs (OpenPaper extension) sets text with mixed styles in one call: the parts in order, each with optional inline styles that override the node's, e.g. [{ "text": "Made with " }, { "text": "love", "styles": { "color": "#FF3E3E", "fontWeight": "700" } }]. Runs can set color, fontFamily, fontSize, fontWeight, fontStyle, letterSpacing, textDecoration (and its longhands), textUnderlineOffset, textTransform and backgroundColor.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `updates` | { nodeId: string, textContent?: string, runs?: { text: string, styles?: Record<string, string \| number> }[] }[] | yes | One entry per text node. |
| `fileId` | string | yes | The file to operate on. |

## `update_shader`

_File-scoped · destructive_

OpenPaper extension. Change the settings of shader layers (GPU effects created with <x-shader> — see get_guide({ topic: "shaders" })). Each update names a shader node and gives a preset to apply and/or params to change; null removes a param (switching an optional group such as grain off). Returns the resulting params. Size, radius, opacity and background are ordinary CSS: use update_styles for those.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `updates` | { nodeId: string, preset?: string, params?: Record<string, number \| string \| boolean \| string[] \| null> }[] | yes | One entry per shader layer. |
| `fileId` | string | yes | The file to operate on. |

## `rename_nodes`

_File-scoped · destructive_

Rename layers (the names shown in the layer tree). Names longer than 200 characters are truncated. Supports batches.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `updates` | { nodeId: string, name: string }[] | yes | One entry per node. |
| `fileId` | string | yes | The file to operate on. |

## `update_styles`

_File-scoped · destructive_

Change styles on one or more nodes — the tool for targeted style edits. Design tokens work as CSS variables. Supports batches.
- Setting top / left on an artboard moves it on the canvas.
- On a Text node with mixed styles, this changes the whole paragraph; styled parts keep their own overrides (change those with set_text_content runs).
- Wherever a URL is accepted, a paper-gen:// URL generates an AI image. Only use it when the user explicitly asked for image generation, and read the "image-generation" guide first.
- Pass an empty string to remove a property.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `updates` | { nodeIds: string[], styles: Record<string, string \| number> }[] | yes | Each entry applies one style object to a list of nodes. |
| `fileId` | string | yes | The file to operate on. |

## `duplicate_nodes`

_File-scoped · destructive_

Duplicate nodes, including all their descendants. Duplicated artboards are placed in an empty area so they don't overlap. Returns the source and new ids plus descendantIdMap, mapping every original descendant id to its copy — since you know the source structure, you can edit the copies right away without re-reading them.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodes` | { id: string, parentId?: string }[] | yes | Nodes to duplicate. |
| `fileId` | string | yes | The file to operate on. |

## `move_nodes`

_File-scoped · destructive_

Reorders or reparents existing layers. Ids are preserved, so any ids you already hold stay valid — use this rather than duplicating and deleting, or rewriting HTML, when the content itself isn't changing.
Each move has one of two shapes:
1. Relative to a sibling: { nodeId, before: siblingId } or { nodeId, after: siblingId } — the parent is the sibling's parent.
2. Explicit parent: { nodeId, parentId, index? } — index is the position among the parent's children (0 = first); omit it to append.
Moves run in order, and each sees the result of the previous ones.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `moves` | { nodeId: string, before: string } \| { nodeId: string, after: string } \| { nodeId: string, parentId: string, index?: integer }[] | yes | Moves, applied in order. |
| `fileId` | string | yes | The file to operate on. |

## `finish_working_on_nodes`

_File-scoped · readOnly_

You MUST call this when you are done. It removes the "working" indicator from the artboards you edited.
Call it without arguments to release every indicator, or pass artboard ids to release only some — prefer passing ids so you play well with other agents.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodeIds` | string[] |  | Specific node ids to release. Omit to release all of your working indicators. |
| `fileId` | string | yes | The file to operate on. |

## `get_tokens`

_File-scoped · readOnly_

List the file's design tokens (colors, spacing, typography, …).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `types` | "color" \| "fontFamily" \| "fontSize" \| "fontWeight" \| "letterSpacing" \| "lineHeight" \| "opacity" \| "breakpoint" \| "container" \| "spacing" \| "radius"[] |  | Only these token types. Omit for all. |
| `namePattern` | string |  | Case-insensitive glob over the full CSS variable name, "*" as wildcard: "--color-primary", "--color-*", "*-500", "*brand*". |
| `format` | "json" \| "css" \| "tailwind" |  | "json" (default) structured tokens; "css" a :root { … } stylesheet; "tailwind" a Tailwind v4 @theme { … } block. |
| `fileId` | string | yes | The file to operate on. |

## `create_tokens`

_File-scoped · destructive_

Adds design tokens. Give each one a type, a name — the complete CSS custom property, such as "--color-primary" — and a value; a value of var(--another-token) makes it an alias. The result has one entry per token: { name, result: "created" } or { name, result: "error", message }. Tokens keep the order you create them in, so add semantic colors (neutrals, then primary, secondary and accent) before raw palette colors, and type sizes from small to large.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tokens` | { type: "color" \| "fontFamily" \| "fontSize" \| "fontWeight" \| "letterSpacing" \| "lineHeight" \| "opacity" \| "breakpoint" \| "container" \| "spacing" \| "radius", name: string, value: string \| number }[] | yes | Tokens to create. Duplicate names are allowed but discouraged. |
| `fileId` | string | yes | The file to operate on. |

## `set_tokens`

_File-scoped · destructive_

Changes or removes existing tokens, identified by their complete CSS variable name. Every entry needs name; newName, value and delete are optional.
- Rename: set newName.
- Change the value: set value (var(--other-token) makes an alias).
- Delete: set delete: true.
Returns one result per entry; per-entry errors are reported in the results.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tokens` | { name: string, newName?: string, value?: string \| number, delete?: boolean }[] | yes | Token edits, applied in order. |
| `fileId` | string | yes | The file to operate on. |

## `get_keyframes`

_File-scoped · readOnly_

OpenPaper extension. The file's CSS @keyframes animations, each with its CSS and the layers that play it (through their animation style). Also lists animation names layers use that no keyframes define. See get_guide({ topic: "animation" }).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `names` | string[] |  | Only these keyframes. Omit for all. |
| `fileId` | string | yes | The file to operate on. |

## `set_keyframes`

_File-scoped · destructive_

OpenPaper extension. Create, change, rename or delete the file's @keyframes; layers play them through their animation style (update_styles: {"animation": "rise 600ms ease-out both"}).
- Create or change: name and css, e.g. { "name": "rise", "css": "from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: none }" } (a whole "@keyframes rise { … }" rule works too).
- Rename: newName; layers that play the old name are updated.
- Delete: delete: true (layers that use it stop moving).
Returns one result per entry.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `keyframes` | { name: string, css?: string, newName?: string, delete?: boolean }[] | yes | Keyframes edits, applied in order. |
| `fileId` | string | yes | The file to operate on. |


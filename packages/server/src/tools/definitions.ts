import { z } from 'zod';
import { TOKEN_TYPES } from '@openpaper/core';
import { toInputJsonSchema } from './schema.ts';

/**
 * MCP tool definitions. Names, parameters and JSON shapes are compatible with Paper's
 * MCP server so agents (and prompts) written for Paper work with OpenPaper unchanged.
 */

export type ToolScope = 'app' | 'file' | 'file-optional-id';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  consequentialHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  scope: ToolScope;
  description: string;
  annotations: ToolAnnotations;
  /** Declared parameters (fileId is added according to the scope). */
  input: z.ZodObject<z.ZodRawShape>;
}

export const PAGE_ICONS = [
  'arrow',
  'padlock',
  'check',
  'cross',
  'info',
  'question',
  'design',
  'vector',
  'images',
  'table',
  'presentation',
  'blueprint',
  'swatches',
  'bar-chart',
  'line-chart',
  'pie-chart',
  'paper',
] as const;

export const GUIDE_TOPICS = [
  ['paper-mcp-instructions', 'How to get the most out of the OpenPaper MCP tools (read this first)'],
  ['mobile-status-bar', 'Ready-to-paste status bar markup for mobile artboards'],
  ['figma-import', 'Workflow for bringing Figma designs into OpenPaper'],
  ['image-generation', 'Generating AI images inside write_html, update_styles and create_artboard with paper-gen:// URLs'],
  ['shaders', 'Shader layers (GPU effects: mesh gradients, grain, dithering, image filters…): the x-shader tag and every effect\'s parameters (OpenPaper extension)'],
  ['animation', 'Motion: CSS @keyframes animations, video, Lottie and scripted (JavaScript) embed layers, and checking them with screenshots (OpenPaper extension)'],
] as const;

const pageIdParam = z
  .string()
  .describe(
    "The page to operate on. Defaults to the page the user is viewing, which can change between calls — prefer passing explicit page ids."
  );

const iconParam = z
  .enum(PAGE_ICONS)
  .describe(
    'Decorative icon shown in the page list (it does not change page behavior). Notes: arrow: a bold arrow, handy for a starting page; design: a pen nib, for design work; paper: a crumpled sheet, for scraps and junk.'
  );

const styleValue = z.union([z.string(), z.number()]);

const exportEntry = z.object({
  format: z.enum(['avif', 'jpg', 'mp4', 'pdf', 'png', 'svg', 'webm', 'webp']).describe('File format.'),
  scale: z
    .string()
    .regex(/^\d+(\.\d+)?(x|w|h|p)$/, {
      message:
        'Invalid scale. Use a number with a unit suffix — x = multiplier, w = target width, h = target height, p = shortest side in pixels — for example "2x", "512w" or "1080p".',
    })
    .describe('Size: a multiplier ("2x"), a target width ("512w"), height ("720h") or shortest side in pixels ("1080p").'),
  durationSeconds: z.number().min(1).max(300).default(10).describe('Video length in seconds (video formats only).'),
  pdfQuality: z.enum(['low', 'medium', 'high']).default('high').describe('Image quality inside PDFs.'),
  pdfResampling: z.enum(['detailed', 'basic']).default('detailed').describe('Image resampling inside PDFs.'),
});

const tokenType = z.enum(TOKEN_TYPES as unknown as [string, ...string[]]);
const tokenName = z.string().regex(/^--[a-zA-Z0-9_-]+$/);

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ---- files & pages -----------------------------------------------------
  {
    name: 'open_file',
    scope: 'app',
    annotations: { readOnlyHint: true },
    description:
      'Open an OpenPaper file by id or URL so later calls can target it. pageId only applies when the file is not already open; an open file never switches pages under the user. Returns the same payload as get_basic_info.',
    input: z.object({
      fileId: z.string().min(1).describe('The file to open: a bare file id, a /file/<id> route or an OpenPaper file URL.'),
      pageId: z
        .string()
        .optional()
        .describe('Page to show when the file is first opened. Ignored when the file is already open so the user is not pulled away from their page.'),
    }),
  },
  {
    name: 'list_resources',
    scope: 'app',
    annotations: { readOnlyHint: true },
    description:
      'Lists the files and folders on this computer. Every entry carries its type ("file" | "folder") and, unless it sits at the top level, a parentId. Files that are open in an editor come first — `open` = open in some editor tab, `active` = the tab in front of the user — followed by everything else, newest update first.',
    input: z.object({
      limit: z.number().int().min(1).max(200).optional().describe('Maximum number of items to return (default 50).'),
    }),
  },
  {
    name: 'create_file',
    scope: 'app',
    annotations: { destructiveHint: true },
    description: "Create a new file and return its id and URL. Call open_file with the returned id to start working in it.",
    input: z.object({
      cloneFileId: z.string().optional().describe('Optional id of a file to copy. The new file starts as a copy of it.'),
      name: z.string().optional().describe('Optional display name for the new file.'),
    }),
  },
  {
    name: 'rename_resource',
    scope: 'app',
    annotations: { destructiveHint: true },
    description:
      'Renames a file or folder as shown in the file browser. Surrounding whitespace is trimmed and names are capped at 500 characters; an empty name changes nothing. The response echoes the saved name and the resource type.',
    input: z.object({
      resourceId: z.string().describe('Id of the file or folder.'),
      name: z.string().describe('The new name.'),
    }),
  },
  {
    name: 'create_page',
    scope: 'file',
    annotations: { destructiveHint: true },
    description:
      "Add a page right after the page the user is viewing and return its id (reorder with arrange_pages). The user's view does not change; pass the returned pageId to other tools to work on the new page.",
    input: z.object({
      name: z.string().optional().describe('Display name for the page list. Defaults to "Page N".'),
      icon: iconParam.optional(),
    }),
  },
  {
    name: 'update_pages',
    scope: 'file',
    annotations: { destructiveHint: true },
    description:
      'Rename pages and/or change their icons, several at once. Does not change which page the user is viewing.',
    input: z.object({
      updates: z
        .array(
          z.object({
            pageId: z.string().describe('Page to update.'),
            name: z.string().optional().describe('New display name.'),
            icon: iconParam.nullable().optional().describe('New icon, or null to restore the default icon.'),
          })
        )
        .describe('One entry per page: the page id plus the fields to change.'),
    }),
  },
  {
    name: 'arrange_pages',
    scope: 'file',
    annotations: { destructiveHint: true },
    description:
      'Reorder the page list and add or remove dividers (visual separators between groups of pages) in one call. Pass the complete new order. If an item is missing, repeated or unknown — which also happens when pages changed since you read the list — the call is rejected and nothing changes. Pages are never deleted and the user stays on their page. Returns the updated page list.',
    input: z.object({
      order: z
        .array(z.union([z.string(), z.object({ type: z.literal('divider') })]))
        .describe(
          'Each page and divider id from get_basic_info, once, in the order you want (leave out dividers you are removing via removeDividerIds). Insert { "type": "divider" } at every spot that should get a new divider.'
        ),
      removeDividerIds: z.array(z.string()).optional().describe('Ids of existing dividers to remove.'),
    }),
  },

  // ---- reading -----------------------------------------------------------
  {
    name: 'get_basic_info',
    scope: 'file-optional-id',
    annotations: { readOnlyHint: true },
    description: `Essential context about a design: file name, page name, node count, the page's artboards with sizes and canvas positions, the page list, font families in use and a compact list of design tokens. Call this first.
- Without fileId the file the user is viewing is used; without pageId, the page they are viewing.
- worldX/worldY are canvas coordinates. Sizes and positions are null when they depend on layout (fit-content, flex children) that has not been measured.
- pages lists pages (type "page") and dividers (type "divider") in display order. Dividers have no canvas, so their ids can't be used as pageId.
- isActive flags the page currently on the user's screen (this may change mid-task). To work on a different page without moving the user's view, give page-scoped tools (create_artboard, export, get_basic_info) a pageId; node-based tools always operate on the page that contains the node.`,
    input: z.object({ pageId: pageIdParam.optional() }),
  },
  {
    name: 'get_selection',
    scope: 'file-optional-id',
    annotations: { readOnlyHint: true },
    description:
      'The nodes the user currently has selected: ids, names, component types, sizes, positions and the artboard each belongs to. Without fileId the file the user is viewing is used.',
    input: z.object({}),
  },
  {
    name: 'get_node_info',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description: `Details about one node: size, visibility, lock state, parent, child ids, text (Text nodes), canvas position (worldX/worldY) and position inside its parent (x/y).
- Nodes with an AI-generated image also report imageGeneration: status is "processing", "ready" or "error", and output is "raster" or "svg". Call again later to see whether generation is done.
- Text with mixed styles (a bold word, a link) also reports textRuns: the text in order, each part with the inline styles that override the node's own.
- Positions are null when they depend on layout that has not been measured.`,
    input: z.object({ nodeId: z.string().describe('Id of the node to inspect.') }),
  },
  {
    name: 'get_children',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description: `The direct children of a node: ids, names, component types, how many children each has, canvas position (worldX/worldY) and position inside the parent (x/y).
- Positions are null when they depend on layout that has not been measured.
- Errors if the node does not exist.`,
    input: z.object({ nodeId: z.string().describe('Id of the parent node.') }),
  },
  {
    name: 'get_screenshot',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description:
      'Capture a node as an image (base64 JPEG), automatically capped to fit model size limits. The default scale of 1 is enough to check layout, spacing and color; use scale 2 only to read small text or inspect fine detail. For more resolution, capture child nodes instead.',
    input: z.object({
      nodeId: z.string().describe('Id of the node to capture.'),
      scale: z.number().optional().describe('1 (default) for layout checks; 2 to read small text or fine detail.'),
      animationTime: z
        .number()
        .min(0)
        .optional()
        .describe('OpenPaper extension: show animations this many milliseconds after they start. Omit for the settled design.'),
    }),
  },
  {
    name: 'get_jsx',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description:
      'JSX for a node and its descendants, styled with Tailwind classes (default, with inline fallbacks) or with inline styles.',
    input: z.object({
      nodeId: z.string().describe('Id of the root node.'),
      format: z
        .enum(['tailwind', 'inline-styles'])
        .optional()
        .describe('"tailwind" (default) uses Tailwind classes with inline fallbacks; "inline-styles" uses only inline styles.'),
      includeNodeIds: z
        .boolean()
        .optional()
        .describe('Add an id attribute with the node id to every element (default true) so you can target nodes. Pass false when exporting clean code for a codebase.'),
      includeRootPositioning: z
        .boolean()
        .optional()
        .describe("Keep the root element's absolute canvas position (position/top/left/right/bottom). Default false, so the JSX is portable."),
    }),
  },
  {
    name: 'get_tree_summary',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description: `A compact, indented outline of a subtree.
- One line per node with its component type, name, id and size; sizes show "?" when they depend on unmeasured layout.
- Far cheaper than get_jsx — use it to orient yourself before reading specific nodes.
- Errors if the node does not exist.`,
    input: z.object({
      nodeId: z.string().describe('Id of the root node.'),
      depth: z.number().optional().describe('How many levels to show (default 3, max 10). Deeper nodes appear as a child count.'),
    }),
  },
  {
    name: 'get_computed_styles',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description:
      'The CSS of one or more nodes as a map of nodeId → camelCase style object. Use it for exact values when writing code. Values bound to design tokens appear as var(--token-name).',
    input: z.object({ nodeIds: z.array(z.string()).describe('Ids of the nodes to read.') }),
  },
  {
    name: 'get_fill_image',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description:
      "Returns a node's image fill as a base64 JPEG (downscaled to stay within API limits) plus metadata including the source URL of the full-resolution file. A missing node is an error; nodes without an image fill, SVG nodes (read those with get_jsx) and images still being generated return an explanatory message instead.",
    input: z.object({ nodeId: z.string().describe('Id of the node with the image fill.') }),
  },
  {
    name: 'find_nodes',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description:
      'Search for nodes by style, by text, or both — handy for locating every use of a color, token or phrase before changing them all. The whole file is searched unless you narrow it with pageId (a single page) or nodeId (a node plus its descendants; takes precedence over pageId). Pass `filters`, `textValue`, or both (all must match). Filters are { styleName, styleValue }: names are case-insensitive and dash-insensitive (background-color = backgroundColor); values are case-insensitive with `*` as a wildcard anchored to the whole value ("8px", "var(--color-*)", "*Inter*"). Color values match the same color in any notation, colors inside compound values, and color tokens that resolve to it. Returns up to 200 nodes with what matched.',
    input: z
      .object({
        pageId: z.string().optional().describe('Search only this page. Omit (with nodeId) to search every page.'),
        nodeId: z.string().optional().describe('Search this node and its descendants. Takes priority over pageId.'),
        textValue: z
          .string()
          .optional()
          .describe('Match Text node content (case-insensitive; "*" wildcard anchored to the whole text, e.g. "*sign up*").'),
        filters: z
          .array(
            z
              .object({
                styleName: z.string().optional().describe('CSS property, e.g. "color", "padding", "font-family". Supports "*".'),
                styleValue: z.string().optional().describe('Value or token, e.g. "#3b82f6", "var(--color-primary)", "16px". Supports "*".'),
              })
              .refine((f) => !!(f.styleName || f.styleValue), { message: 'Each filter needs styleName or styleValue.' })
          )
          .min(1)
          .optional()
          .describe('Style matchers that must all match.'),
      })
      .refine((v) => v.textValue !== undefined || (v.filters?.length ?? 0) > 0, { message: 'Provide `textValue` or at least one filter.' }),
  },

  // ---- comments ----------------------------------------------------------
  {
    name: 'list_comment_threads',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description:
      'Summaries of the comment threads in this file. Each thread is attached to a node and consists of an opening message and its replies; its status is "open" or "resolved". By default only open threads are returned. Fetch a whole conversation with get_comment_thread, and once the design addresses a thread\'s feedback, mark it resolved with set_comment_thread_status.',
    input: z.object({
      pageId: z.string().optional().describe('Only threads on this page. Omit for all pages.'),
      currentPageOnly: z.boolean().optional().describe("Only threads on the user's current page. Ignored when pageId is given."),
      nodeId: z.string().optional().describe('Only threads pinned to this node.'),
      status: z.enum(['open', 'resolved', 'all']).optional().describe('Default "open" (threads still needing action). "resolved" or "all" for others.'),
      search: z.string().optional().describe('Case-insensitive search over author names and message text.'),
      searchScope: z.enum(['first-message', 'all-messages']).optional().describe('Search only first messages, or all messages (default).'),
      participantUserId: z
        .string()
        .optional()
        .describe('Only threads where this user wrote a message. "current-user" means the person using OpenPaper.'),
      threadAuthorUserId: z.string().optional().describe('Only threads started by this user. "current-user" means the person using OpenPaper.'),
      sortField: z.enum(['page', 'createdAt', 'updatedAt']).optional().describe('Sort key (default "page", like the comments panel).'),
      sortDirection: z.enum(['asc', 'desc']).optional().describe('Sort direction (default "asc").'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum threads to return (default 50).'),
      offset: z.number().int().min(0).optional().describe('Matching threads to skip (default 0).'),
      previewLength: z.number().int().min(20).max(1000).optional().describe('Maximum characters of each first-message preview (default 240).'),
    }),
  },
  {
    name: 'get_comment_thread',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description:
      'Full details of one comment thread: status, every message with reactions and attachments, the page and the pinned node. Works for any status. Use list_comment_threads first to find thread ids.',
    input: z.object({ commentThreadId: z.string().min(1).describe('Id of the comment thread.') }),
  },
  {
    name: 'list_comment_thread_authors',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description:
      'People who have commented in this file (opened a thread or replied), each with userId, display name, how many threads and messages they wrote and when they were last active. Use it to look up the userId behind a name for list_comment_threads filters.',
    input: z.object({ pageId: z.string().optional().describe('Only count activity on this page. Omit for all pages.') }),
  },
  {
    name: 'set_comment_thread_status',
    scope: 'file',
    annotations: { destructiveHint: true },
    description:
      'Mark a comment thread "resolved" once its feedback is fully addressed in the design, or "open" to reopen it if more work is needed.',
    input: z.object({
      commentThreadId: z.string().min(1).describe('Id of the comment thread.'),
      status: z.enum(['open', 'resolved']).describe('"resolved" when addressed, "open" to reopen.'),
    }),
  },

  // ---- fonts & guides ----------------------------------------------------
  {
    name: 'get_font_family_info',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description:
      'Check whether font families are available (installed on this computer or on Google Fonts) and list every weight and style they offer. Call before your first typographic styling in a session.',
    input: z.object({ familyNames: z.array(z.string()).describe('Font family names to look up, e.g. ["Inter", "Fraunces"].') }),
  },
  {
    name: 'get_guide',
    scope: 'app',
    annotations: { readOnlyHint: true },
    description: `Read a detailed guide. Call with topic "paper-mcp-instructions" before using the other tools for best results. Other topics: ${GUIDE_TOPICS.slice(1)
      .map(([t]) => `"${t}"`)
      .join(', ')}.`,
    input: z.object({
      topic: z
        .string()
        .describe(`Guide to read. Available topics:\n${GUIDE_TOPICS.map(([t, d]) => `"${t}" — ${d}`).join('\n')}`),
    }),
  },

  // ---- export --------------------------------------------------------------
  {
    name: 'export',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description:
      "Export nodes to image or PDF files on the user's computer and return the file paths. Unless the user asks for something specific, keep the default export settings.",
    input: z.object({
      pageId: pageIdParam.optional(),
      type: z.enum(['image', 'video']).optional().describe('Export type (default "image").'),
      nodes: z
        .union([
          z.literal('nodes-with-exports-only'),
          z.record(z.string(), z.array(exportEntry)),
        ])
        .describe(
          'Either "nodes-with-exports-only" (export every node on the page that has saved export settings) or a map of nodeId → export settings; an empty array uses the node\'s saved settings or the defaults (PNG at 2x).'
        ),
    }),
  },
  {
    name: 'export_combined_pdf',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description:
      'Combines several nodes into one PDF with a page per node. Pages follow the nodes\' placement on the canvas: rows from top to bottom, and left to right within a row. Choose this over export whenever a single combined PDF is wanted.',
    input: z.object({
      nodeIds: z.array(z.string()).min(1).describe('Ids of the nodes to combine, one PDF page each.'),
    }),
  },

  // ---- writing -------------------------------------------------------------
  {
    name: 'write_html',
    scope: 'file',
    annotations: { destructiveHint: true },
    description: `IMPORTANT: work in small steps. The user is watching the canvas while you design, so something new should appear every few seconds.
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
- OpenPaper extension, motion: the animation style plays on the canvas, with @keyframes from a <style> element in the same HTML; <video>, <x-lottie src> and <x-embed> (HTML and JavaScript run in a sandbox) add layers that play. Read get_guide({ topic: "animation" }) before adding motion.`,
    input: z.object({
      html: z.string().describe('HTML to turn into design nodes. Standard elements with inline CSS styles (a <style> element may define @keyframes).'),
      targetNodeId: z
        .string()
        .describe('Target node. "insert-children" appends the new nodes inside it; "replace" removes it and puts the new nodes in its place.'),
      mode: z
        .enum(['insert-children', 'replace'])
        .describe('"insert-children": add the new layers inside the target, after its existing children. "replace": put the new layers where the target was and remove the target.'),
    }),
  },
  {
    name: 'create_artboard',
    scope: 'file',
    annotations: { destructiveHint: true },
    description: `Create an artboard (a top-level frame) on the canvas and return its node id; then add content with write_html({ mode: "insert-children" }).
- Set its size and look with styles. Artboards default to display: "flex", flexDirection: "column".
- The artboard is placed in a free spot on the canvas. Pass pageId to create it on a specific page; omit it to use the page the user is viewing.
- A paper-gen:// URL in a style such as backgroundImage produces an AI image; use it only on request, after reading get_guide({ topic: "image-generation" }).
- Unless the user gives a size, use a default device size:
  - Desktop: 1440 × 900px
  - Tablet: 768 × 1024px
  - Mobile: 390 × 844px — start it with a status bar: get_guide({ topic: "mobile-status-bar" }) has paste-ready markup; don't draw one by hand.
The device height is only a starting point to show what fits above the fold. When you finish, if content is clipped, switch the artboard to height: "fit-content" with update_styles instead of guessing another fixed height.`,
    input: z.object({
      pageId: pageIdParam.optional(),
      name: z.string().describe('Artboard name (shown in the layer tree).'),
      styles: z
        .object({
          width: z.string().describe('Width in whole pixels, e.g. "1440px".'),
          height: z.string().describe('Height in whole pixels, e.g. "900px".'),
        })
        .catchall(styleValue)
        .describe(
          'The artboard\'s CSS as a camelCase object; width and height (whole pixels) are required. If you choose the position yourself, keep 80px of space between artboards. Example: {"width": "390px", "height": "844px", "display": "flex", "flexDirection": "column", "gap": "16px", "backgroundColor": "#FFFFFF"}'
        ),
    }),
  },
  {
    name: 'delete_nodes',
    scope: 'file',
    annotations: { destructiveHint: true, consequentialHint: true },
    description:
      'Delete nodes and all of their descendants. IMPORTANT: if you are deleting a node because you think it has the wrong parent, confirm with get_node_info first.',
    input: z.object({ nodeIds: z.array(z.string()).describe('Ids of the nodes to delete.') }),
  },
  {
    name: 'set_text_content',
    scope: 'file',
    annotations: { destructiveHint: true },
    description: `Change the text of one or more Text nodes (component type "Text" only). Use it instead of write_html replace when only the copy changes. Supports batches.
- textContent sets plain text: any mixed styles in the node are removed.
- runs (OpenPaper extension) sets text with mixed styles in one call: the parts in order, each with optional inline styles that override the node's, e.g. [{ "text": "Made with " }, { "text": "love", "styles": { "color": "#FF3E3E", "fontWeight": "700" } }]. Runs can set color, fontFamily, fontSize, fontWeight, fontStyle, letterSpacing, textDecoration (and its longhands), textUnderlineOffset, textTransform and backgroundColor.`,
    input: z.object({
      updates: z
        .array(
          z.object({
            nodeId: z.string().describe('Text node id.'),
            textContent: z.string().optional().describe('New text. Required unless runs is given.'),
            runs: z
              .array(
                z.object({
                  text: z.string().describe('Text of this part.'),
                  styles: z.record(z.string(), styleValue).optional().describe('Inline styles for this part (camelCase CSS); omit for the node\'s own style.'),
                })
              )
              .optional()
              .describe('OpenPaper extension: the text as styled parts; their texts join to the new text.'),
          })
        )
        .describe('One entry per text node.'),
    }),
  },
  {
    name: 'update_shader',
    scope: 'file',
    annotations: { destructiveHint: true },
    description:
      'OpenPaper extension. Change the settings of shader layers (GPU effects created with <x-shader> — see get_guide({ topic: "shaders" })). Each update names a shader node and gives a preset to apply and/or params to change; null removes a param (switching an optional group such as grain off). Returns the resulting params. Size, radius, opacity and background are ordinary CSS: use update_styles for those.',
    input: z.object({
      updates: z
        .array(
          z.object({
            nodeId: z.string().describe('Id of the shader layer.'),
            preset: z.string().optional().describe('Preset to apply before params, e.g. "Default" (see the shaders guide for each effect\'s presets).'),
            params: z
              .record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.array(z.string()), z.null()]))
              .optional()
              .describe('Params by name, e.g. { "colors": ["#ff5f6d", "#2b5876"], "speed": 0.4, "grainMixer": null }.'),
          })
        )
        .min(1)
        .describe('One entry per shader layer.'),
    }),
  },
  {
    name: 'rename_nodes',
    scope: 'file',
    annotations: { destructiveHint: true },
    description: 'Rename layers (the names shown in the layer tree). Names longer than 200 characters are truncated. Supports batches.',
    input: z.object({
      updates: z
        .array(z.object({ nodeId: z.string().describe('Node id.'), name: z.string().describe('New layer name.') }))
        .describe('One entry per node.'),
    }),
  },
  {
    name: 'update_styles',
    scope: 'file',
    annotations: { destructiveHint: true },
    description: `Change styles on one or more nodes — the tool for targeted style edits. Design tokens work as CSS variables. Supports batches.
- Setting top / left on an artboard moves it on the canvas.
- On a Text node with mixed styles, this changes the whole paragraph; styled parts keep their own overrides (change those with set_text_content runs).
- Wherever a URL is accepted, a paper-gen:// URL generates an AI image. Only use it when the user explicitly asked for image generation, and read the "image-generation" guide first.
- Pass an empty string to remove a property.`,
    input: z.object({
      updates: z
        .array(
          z.object({
            nodeIds: z.array(z.string()).describe('Nodes that receive these styles.'),
            styles: z.record(z.string(), styleValue).describe('camelCase CSS properties to set, e.g. {"gap": "12px", "color": "var(--color-text)"}.'),
          })
        )
        .describe('Each entry applies one style object to a list of nodes.'),
    }),
  },
  {
    name: 'duplicate_nodes',
    scope: 'file',
    annotations: { destructiveHint: true },
    description:
      'Duplicate nodes, including all their descendants. Duplicated artboards are placed in an empty area so they don\'t overlap. Returns the source and new ids plus descendantIdMap, mapping every original descendant id to its copy — since you know the source structure, you can edit the copies right away without re-reading them.',
    input: z.object({
      nodes: z
        .array(
          z.object({
            id: z.string().describe('Node to duplicate.'),
            parentId: z.string().optional().describe('Where to put the copy. Defaults to the same parent, right after the original.'),
          })
        )
        .describe('Nodes to duplicate.'),
    }),
  },
  {
    name: 'move_nodes',
    scope: 'file',
    annotations: { destructiveHint: true },
    description: `Reorders or reparents existing layers. Ids are preserved, so any ids you already hold stay valid — use this rather than duplicating and deleting, or rewriting HTML, when the content itself isn't changing.
Each move has one of two shapes:
1. Relative to a sibling: { nodeId, before: siblingId } or { nodeId, after: siblingId } — the parent is the sibling's parent.
2. Explicit parent: { nodeId, parentId, index? } — index is the position among the parent's children (0 = first); omit it to append.
Moves run in order, and each sees the result of the previous ones.`,
    input: z.object({
      moves: z
        .array(
          z.union([
            z.object({ nodeId: z.string(), before: z.string() }),
            z.object({ nodeId: z.string(), after: z.string() }),
            z.object({ nodeId: z.string(), parentId: z.string(), index: z.number().int().min(0).optional() }),
          ])
        )
        .min(1)
        .describe('Moves, applied in order.'),
    }),
  },
  {
    name: 'finish_working_on_nodes',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description: `You MUST call this when you are done. It removes the "working" indicator from the artboards you edited.
Call it without arguments to release every indicator, or pass artboard ids to release only some — prefer passing ids so you play well with other agents.`,
    input: z.object({
      nodeIds: z.array(z.string()).optional().describe('Specific node ids to release. Omit to release all of your working indicators.'),
    }),
  },

  // ---- tokens --------------------------------------------------------------
  {
    name: 'get_tokens',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description: "List the file's design tokens (colors, spacing, typography, …).",
    input: z.object({
      types: z.array(tokenType).optional().describe('Only these token types. Omit for all.'),
      namePattern: z
        .string()
        .optional()
        .describe('Case-insensitive glob over the full CSS variable name, "*" as wildcard: "--color-primary", "--color-*", "*-500", "*brand*".'),
      format: z
        .enum(['json', 'css', 'tailwind'])
        .optional()
        .describe('"json" (default) structured tokens; "css" a :root { … } stylesheet; "tailwind" a Tailwind v4 @theme { … } block.'),
    }),
  },
  {
    name: 'create_tokens',
    scope: 'file',
    annotations: { destructiveHint: true },
    description:
      'Adds design tokens. Give each one a type, a name — the complete CSS custom property, such as "--color-primary" — and a value; a value of var(--another-token) makes it an alias. The result has one entry per token: { name, result: "created" } or { name, result: "error", message }. Tokens keep the order you create them in, so add semantic colors (neutrals, then primary, secondary and accent) before raw palette colors, and type sizes from small to large.',
    input: z.object({
      tokens: z
        .array(z.object({ type: tokenType, name: tokenName, value: styleValue }))
        .min(1)
        .describe('Tokens to create. Duplicate names are allowed but discouraged.'),
    }),
  },
  {
    name: 'set_tokens',
    scope: 'file',
    annotations: { destructiveHint: true },
    description: `Changes or removes existing tokens, identified by their complete CSS variable name. Every entry needs name; newName, value and delete are optional.
- Rename: set newName.
- Change the value: set value (var(--other-token) makes an alias).
- Delete: set delete: true.
Returns one result per entry; per-entry errors are reported in the results.`,
    input: z.object({
      tokens: z
        .array(z.object({ name: tokenName, newName: tokenName.optional(), value: styleValue.optional(), delete: z.boolean().optional() }))
        .min(1)
        .describe('Token edits, applied in order.'),
    }),
  },

  // ---- animation -------------------------------------------------------------
  {
    name: 'get_keyframes',
    scope: 'file',
    annotations: { readOnlyHint: true },
    description:
      "OpenPaper extension. The file's CSS @keyframes animations, each with its CSS and the layers that play it (through their animation style). Also lists animation names layers use that no keyframes define. See get_guide({ topic: \"animation\" }).",
    input: z.object({
      names: z.array(z.string()).optional().describe('Only these keyframes. Omit for all.'),
    }),
  },
  {
    name: 'set_keyframes',
    scope: 'file',
    annotations: { destructiveHint: true },
    description: `OpenPaper extension. Create, change, rename or delete the file's @keyframes; layers play them through their animation style (update_styles: {"animation": "rise 600ms ease-out both"}).
- Create or change: name and css, e.g. { "name": "rise", "css": "from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: none }" } (a whole "@keyframes rise { … }" rule works too).
- Rename: newName; layers that play the old name are updated.
- Delete: delete: true (layers that use it stop moving).
Returns one result per entry.`,
    input: z.object({
      keyframes: z
        .array(
          z.object({
            name: z.string().describe('Keyframes name (letters, digits, - and _).'),
            css: z.string().optional().describe('The keyframe steps: from / to / percentages with declarations.'),
            newName: z.string().optional().describe('Rename to this.'),
            delete: z.boolean().optional().describe('Remove these keyframes.'),
          })
        )
        .min(1)
        .describe('Keyframes edits, applied in order.'),
    }),
  },
];

const FILE_ID_REQUIRED = z.string().describe('The file to operate on.');
const FILE_ID_OPTIONAL = z
  .string()
  .optional()
  .describe('The file to operate on. Defaults to the file the user is viewing.');

/** The full input schema including `fileId` for file-scoped tools. */
export function inputSchemaFor(def: ToolDefinition): z.ZodType {
  if (def.scope === 'app') return def.input;
  const fileId = def.scope === 'file' ? FILE_ID_REQUIRED : FILE_ID_OPTIONAL;
  // Preserve object-level refinements (find_nodes) by intersecting rather than extending.
  return def.input.and(z.object({ fileId }));
}

let cachedTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations }> | null =
  null;

/** Tool list for MCP `tools/list`. */
export function mcpToolList() {
  cachedTools ??= TOOL_DEFINITIONS.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: jsonSchemaFor(def),
    annotations: def.annotations,
  }));
  return cachedTools;
}

function jsonSchemaFor(def: ToolDefinition): Record<string, unknown> {
  const base = toInputJsonSchema(def.input);
  if (def.scope === 'app') return base;
  const props = { ...((base.properties as Record<string, unknown>) ?? {}) };
  props.fileId = {
    type: 'string',
    description: def.scope === 'file' ? 'The file to operate on.' : 'The file to operate on. Defaults to the file the user is viewing.',
  };
  const required = [...((base.required as string[]) ?? [])];
  if (def.scope === 'file') required.push('fileId');
  return { ...base, properties: props, ...(required.length ? { required } : {}), additionalProperties: false };
}

export const TOOLS_BY_NAME = new Map(TOOL_DEFINITIONS.map((d) => [d.name, d]));

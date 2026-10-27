import { useMemo, type ReactNode } from 'react';
import { parseMarkdown, safeHref, type Block, type Inline } from './markdown.ts';

function inlines(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return node.text;
      case 'code':
        return <code key={i}>{node.text}</code>;
      case 'strong':
        return <strong key={i}>{inlines(node.children)}</strong>;
      case 'em':
        return <em key={i}>{inlines(node.children)}</em>;
      case 'del':
        return <del key={i}>{inlines(node.children)}</del>;
      case 'br':
        return <br key={i} />;
      case 'link': {
        const href = safeHref(node.href);
        return href ? (
          <a key={i} href={href} target="_blank" rel="noreferrer noopener">
            {inlines(node.children)}
          </a>
        ) : (
          <span key={i}>{inlines(node.children)}</span>
        );
      }
    }
  });
}

function blocks(nodes: Block[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'paragraph':
        return <p key={i}>{inlines(node.children)}</p>;
      case 'heading': {
        const Tag = `h${node.level}` as 'h1';
        return <Tag key={i}>{inlines(node.children)}</Tag>;
      }
      case 'code':
        return (
          <pre key={i} className="op-scroll" data-lang={node.lang || undefined}>
            <code>{node.text}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={i}>{blocks(node.children)}</blockquote>;
      case 'list': {
        const items = node.items.map((item, j) => <li key={j}>{blocks(item)}</li>);
        return node.ordered ? (
          <ol key={i} start={node.start === 1 ? undefined : node.start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
      case 'table':
        return (
          <div key={i} className="op-md-table op-scroll">
            <table>
              <thead>
                <tr>
                  {node.head.map((cell, c) => (
                    <th key={c} style={{ textAlign: node.align[c] ?? undefined }}>
                      {inlines(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {node.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} style={{ textAlign: node.align[c] ?? undefined }}>
                        {inlines(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'hr':
        return <hr key={i} />;
    }
  });
}

/** Renders Markdown text (an agent reply) as formatted React elements. */
export function MarkdownView({ text, className }: { text: string; className?: string }) {
  const tree = useMemo(() => parseMarkdown(text), [text]);
  return <div className={`op-md${className ? ` ${className}` : ''}`}>{blocks(tree)}</div>;
}

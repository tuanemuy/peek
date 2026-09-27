# @makuja/peek

Markdown and HTML preview CLI with live reload. Spins up a local web server and renders Markdown and HTML files in the browser with real-time updates via Server-Sent Events.

## Features

- **Markdown & HTML preview** - Renders Markdown with GitHub-flavored styles and previews HTML files in an isolated iframe
- **Live reload** - Automatically refreshes the browser when you save a file
- **Directory browsing** - Specify a directory to browse and preview Markdown and HTML files from a file tree
- **Syntax highlighting** - Code blocks are highlighted with Shiki
- **Custom CSS** - Customize Markdown styles via `--css` flag or `~/.config/peek/style.css`
- **Dark / Light theme** - Built-in theme toggle

## Requirements

- Node.js >= 22.0.0

## Install

```bash
npm install -g @makuja/peek
```

## Usage

```bash
# Preview a Markdown file
peek README.md

# Preview an HTML file
peek index.html

# Browse a directory (Markdown and HTML files)
peek docs/

# Preview current directory
peek

# Specify port and host
peek . --port 8080 --host 0.0.0.0

# Use custom CSS (Markdown only)
peek README.md --css ./custom.css

# Disable auto-open browser
peek README.md --no-open
```

## Options

| Option | Short | Default | Description |
|---|---|---|---|
| `path` | - | `.` | File (`.md`, `.html`, `.htm`) or directory path to preview |
| `--port` | `-p` | `3000` | Server port |
| `--host` | `-H` | `localhost` | Bind hostname (`0.0.0.0` for external access) |
| `--css` | `-c` | - | Path to a custom CSS file (Markdown only) |
| `--open` / `--no-open` | - | `true` | Auto-open browser on start |

## Relative assets

Relative paths resolve against the directory of the previewed file:

- **HTML** - Any relative URL, such as `<img src="./img.png">`, `<link href="style.css">`, or `url(fonts/a.woff2)` in a stylesheet
- **Markdown** - Image paths, such as `![](./img.png)` and reference-style images

peek serves these files from the browsed directory (directory mode) or from the previewed file's directory (file mode), including their subdirectories. When the previewed file is a symlink, its real location is used. peek serves only the following extensions and refuses paths outside that directory, including through symlinks:

- Images: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `avif`, `ico`, `bmp`
- Styles and scripts: `css`, `js`, `mjs`
- Fonts: `woff`, `woff2`, `ttf`, `otf`
- HTML: `html`, `htm`

## Custom CSS

Content styles for Markdown files can be customized in three ways (in priority order):

1. **`--css` flag** - Pass a CSS file path directly
2. **XDG config** - Place a `style.css` at `$XDG_CONFIG_HOME/peek/style.css` or `~/.config/peek/style.css`
3. **Built-in styles** - GitHub-flavored Markdown styles (default)

Custom CSS only affects the `.markdown-body` content area, not the layout chrome.

You can override design tokens (CSS custom properties) for full theme customization. See [`docs/design-token-example.css`](docs/design-token-example.css) for reference.

> **Note:** Custom CSS is not applied to HTML file previews. HTML files are rendered as-is in an isolated iframe with their own styles.

## License

MIT

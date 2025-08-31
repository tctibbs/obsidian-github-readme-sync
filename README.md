# GitHub Readme Sync

An Obsidian plugin that performs **one-way sync** (GitHub → Obsidian) of your repositories' Markdown files (README.md, docs, subfolders, etc.) while preserving the complete folder structure. Perfect for keeping project documentation accessible in your knowledge vault.

## Features

- **Auto-discovery**: Automatically finds all repositories under configured GitHub usernames/organizations
- **Full Structure Mirroring**: Preserves complete repo folder structure so relative links and images work seamlessly
- **Flexible Filtering**: Include/exclude private repos, forks, archived repos, and use glob patterns for repo names
- **Media File Support**: Optionally sync images, GIFs, and other media files (png, jpg, gif, svg, etc.)
- **Private Repository Support**: Sync private repositories with proper GitHub token permissions
- **Read-Only Protection**: Adds frontmatter and banner to mark synced files as read-only
- **Configurable Sync**: Manual "Sync now" command and optional periodic auto-sync
- **Smart Organization**: Files are written to `Projects/<owner>/<repo>/<repo-path>`

## Installation (Development)

1. Clone this repository to your Obsidian vault's plugins folder:
   ```bash
   cd /path/to/your/vault/.obsidian/plugins
   git clone https://github.com/yourusername/obsidian-github-readme-sync.git
   cd obsidian-github-readme-sync
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the plugin:
   ```bash
   npm run build
   ```

4. Enable the plugin in Obsidian settings under **Community Plugins**

## Configuration

1. Open **Settings → GitHub Readme Sync**
2. Add your **GitHub Personal Access Token**
3. Enter your **GitHub username** for auto-discovery
4. Configure repository filters and sync options
5. Use the **"Sync Now"** button to start syncing

## Folder Structure

The plugin mirrors your repository structure exactly:

```
Projects/
├── you/
│   └── my-project/
│       ├── README.md
│       ├── docs/
│       │   └── getting-started.md
│       └── database/
│           └── readme.md
└── yourorg/
    └── team-docs/
        ├── README.md
        └── guides/
            └── deployment.md
```

## File Processing

Each synced Markdown file includes:

1. **Frontmatter** with sync metadata:
   ```yaml
   ---
   github_repo: owner/repo
   github_path: path/to/file.md
   github_url: https://github.com/owner/repo/blob/main/path/to/file.md
   synced_at: 2025-01-15T10:30:00Z
   readonly: true
   ---
   ```

2. **Read-only banner** at the top:
   ```markdown
   > [!WARNING] Read-Only
   > This file is synced from GitHub. Any local changes will be overwritten.
   > View source: [owner/repo](https://github.com/owner/repo/blob/main/path/to/file.md)
   ```

## Commands

- **GitHub Readme Sync: Sync Now** - Manually trigger a full sync of all configured repositories

## GitHub Token Setup

The plugin requires a GitHub Personal Access Token with appropriate scopes:

1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Give it a name like "Obsidian Sync"
4. Select the appropriate scopes:
   - **`public_repo`** - For public repositories only
   - **`repo`** - For both public and private repositories (recommended)
5. Set an expiration date (recommended)
6. Copy the token and paste it into the plugin settings

**Token Scopes:**
- **Public repos only**: Use `public_repo` scope
- **Private repos**: Requires full `repo` scope (includes `public_repo`)

## Limitations

- **One-way sync only**: Changes in Obsidian are not pushed back to GitHub
- **Desktop only**: Not compatible with Obsidian Mobile
- **Rate limits**: Respects GitHub API rate limits (5000 requests/hour for authenticated users)

## File Types Supported

- **Markdown files**: `.md` and `.mdx` files (always synced)
- **Media files** (optional): `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.bmp`, `.ico`
- **Video files** (optional): `.mp4`, `.mov`, `.avi`, `.webm`
- **Audio files** (optional): `.mp3`, `.wav`
- **Documents** (optional): `.pdf`

## Future Features

- **Official Obsidian Plugin Directory** - Submit to community plugins for easier installation
- **Custom file type filters** - Configure which file types to sync
- **Mobile support** - Potential Obsidian Mobile compatibility (may not be feasible due to API limitations; Obsidian Sync may be a better solution)

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

If you find this plugin helpful, consider:
- ⭐ Starring the repository
- 🐛 Reporting issues on GitHub
- 💡 Suggesting new features


import { MetadataCache, TFile, Vault, getLinkpath } from "obsidian";
import { FlowershowSettings } from "./FlowershowSettings";
import { Base64 } from "js-base64";
import { Octokit } from "@octokit/core";
import { arrayBufferToBase64 } from "./utils";
import { validatePublishFrontmatter, validateSettings } from "./Validator";


export interface MarkedForPublishing {
    notes: TFile[],
    assets: string[]
}

export interface IPublisher {
    publishNote(file: TFile): Promise<void>;
    unpublishNote(path: string): Promise<void>;
    prepareMarkdown(file: TFile): Promise<string>;
    getFilesMarkedForPublishing(): Promise<MarkedForPublishing>;
}

export default class Publisher implements IPublisher {
    private vault: Vault;
    private metadataCache: MetadataCache;
    private settings: FlowershowSettings;

    private notesRepoPath = "";
    private assetsRepoPath = "";

    constructor(vault: Vault, metadataCache: MetadataCache, settings: FlowershowSettings) {
        this.vault = vault;
        this.metadataCache = metadataCache;
        this.settings = settings;
				this.notesRepoPath = settings.notesRepoPath;
				this.assetsRepoPath = settings.assetsRepoPath;
    }

    async publishNote(file: TFile) {
        if (!validatePublishFrontmatter(this.metadataCache.getCache(file.path).frontmatter)) {
            throw {}
        }
        const markdown = await this.prepareMarkdown(file);
        const assets = await this.prepareAssociatedAssets(markdown, file.path);

        await this.uploadMarkdown(markdown, file.path);
        await this.uploadAssets(assets);
    }

    async unpublishNote(notePath: string) {
			const path = `${this.notesRepoPath}/${notePath}`

			console.log(`Unpublishing note ${path}`);
        await this.deleteMarkdown(path);
        // TODO
        // await this.deleteAssets(notePath);
    }

    async prepareMarkdown(file: TFile): Promise<string> {
        return await this.vault.read(file);
    }

    async getFilesMarkedForPublishing(): Promise<MarkedForPublishing> {
        const files = this.vault.getMarkdownFiles();
        const notesToPublish = [];
        const assetsToPublish: Set<string> = new Set();

        for (const file of files) {
            const frontMatter = this.metadataCache.getCache(file.path).frontmatter
            if (!frontMatter || frontMatter["publish"] !== false) {
                notesToPublish.push(file);
                const text = await this.vault.read(file);
                const images = await this.extractEmbeddedImageFiles(text, file.path);
                Object.keys(images).forEach((i) => assetsToPublish.add(i));
                // ... other assets?
            }
        }

        return {
            notes: notesToPublish,
            assets: Array.from(assetsToPublish)
        };
    }

    private async uploadMarkdown(content: string, filePath: string) {
        content = Base64.encode(content);
  			const path = `${this.notesRepoPath}/${filePath}`
  			console.log(`Uploading ${path}`);
	  		await this.uploadToGithub(path, content)
    }

    private async deleteMarkdown(filePath: string) {
			const path = `${this.notesRepoPath}/${filePath}`
			console.log(`Deleting ${path}`);
			await this.deleteFromGithub(path)
    }

    private async uploadAssets(assets: { images: Array<{ path: string, content: string }> }) {
        for (let idx = 0; idx < assets.images.length; idx++) {
            const image = assets.images[idx];
						console.log(`Uploading asset: ${image.path}`);
            await this.uploadImage(image.path, image.content);
        }
    }

    private async deleteAssets(assets: { images: Array<{ path: string }> }) {
        for (let idx = 0; idx < assets.images.length; idx++) {
            const image = assets.images[idx];
						console.log(`Deleted asset: ${this.assetsRepoPath+image.path}`);
            await this.deleteImage(this.assetsRepoPath+image.path);
        }
    }

    private async uploadImage(filePath: string, content: string) {
			const publicPath = `${this.assetsRepoPath}/${filePath}`
			console.log(`uploading image ${publicPath}`);
			await this.uploadToGithub(publicPath, content)
    }

    private async deleteImage(filePath: string) {
			const path = `${this.assetsRepoPath}/${filePath}`
			console.log(`deleting image ${path}`);
			return await this.deleteFromGithub(path);
    }

    private async uploadToGithub(path: string, content: string) {
        if (!validateSettings(this.settings)) {
            throw {}
        }

        const octokit = new Octokit({ auth: this.settings.githubToken });
        const payload = {
            owner: this.settings.githubUserName,
            repo: this.settings.githubRepo,
            path,
            message: `Add content ${path}`,
            content,
            sha: ''
        };

        try {
            const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: this.settings.githubUserName,
                repo: this.settings.githubRepo,
                path
            });
            
            // Handle both single file and directory responses
            const fileData = Array.isArray(response.data) ? null : response.data;
            
            if (response.status === 200 && fileData?.type === "file") {
                payload.message = `Update content ${path}`;
                payload.sha = fileData.sha;
            }

        } catch {
            // don't fail, file just doesn't exist in the repo yet
        }
        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', payload);
    }

    private async deleteFromGithub(path: string) {
        if (!validateSettings(this.settings)) {
            throw {}
        }

        const octokit = new Octokit({ auth: this.settings.githubToken });
        const payload = {
            owner: this.settings.githubUserName,
            repo: this.settings.githubRepo,
            path,
            message: `Delete content ${path}`,
            sha: ''
        };

        const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: this.settings.githubUserName,
            repo: this.settings.githubRepo,
            path
        });

        // Handle both single file and directory responses
        const fileData = Array.isArray(response.data) ? null : response.data;
        
        if (response.status === 200 && fileData?.type === "file") {
            payload.sha = fileData.sha;
        }

        await octokit.request('DELETE /repos/{owner}/{repo}/contents/{path}', payload);
    }

    private async prepareAssociatedAssets(text: string, filePath: string) {
        const assets: { images: Array<{ path: string, content: string }> } = {
            images: [],
            // ... other assets
        };

        const imagePathsToTFilesMap = await this.extractEmbeddedImageFiles(text, filePath);

        for (const path in imagePathsToTFilesMap) {
            const image = imagePathsToTFilesMap[path];
            assets.images.push({
                path,
                content: await this.readImageToBase64(image)
            });

        }
        return assets;
    }

    private async readImageToBase64(file: TFile): Promise<string> {
        const image = await this.vault.readBinary(file);
        const imageBase64 = arrayBufferToBase64(image)
        return imageBase64;
    }

    private async extractEmbeddedImageFiles(text: string, filePath: string): Promise<{ [path: string]: TFile }> {
        const embeddedImageFiles: { [path: string]: TFile } = {};

        //![[image.png]]
        const embeddedImageRegex = /!\[\[(.*?\.(png|webp|jpg|jpeg|gif|bmp|svg))(?:\|(.*?))?\]\]/g;
        const embeddedImageMatches = [...text.matchAll(embeddedImageRegex)];

        if (embeddedImageMatches) {
            for (let i = 0; i < embeddedImageMatches.length; i++) {
                try {
                    // `path` below can be a full path or Obsidian-style shortened path, i.e. just a file name with extension
                    // const [, path, extension, size = null] = embeddedImageMatches[i];
                    const [, path] = embeddedImageMatches[i];
                    const imagePath = getLinkpath(path);
                    const linkedFile = this.metadataCache.getFirstLinkpathDest(imagePath, filePath);

                    if (!embeddedImageFiles[linkedFile.path]) {
                        embeddedImageFiles[linkedFile.path] = linkedFile;
                    }
                } catch {
                    continue;
                }
            }
        }

        const imageRegex = /!\[.*?\]\((.*?\.(png|webp|jpg|jpeg|gif|bmp|svg))\)/g;
        const imageMatches = [...text.matchAll(imageRegex)];

        if (imageMatches) {
            for (let i = 0; i < imageMatches.length; i++) {
                try {
                    // const [, path, extension] = imageMatches[i];
                    const [, path] = imageMatches[i];

                    if (path.startsWith("http")) {
                        continue;
                    }

                    // const decodedImagePath = decodeURI(imagePath);
                    const imagePath = getLinkpath(path);
                    const linkedFile = this.metadataCache.getFirstLinkpathDest(imagePath, filePath);
                    if (!embeddedImageFiles[linkedFile.path]) {
                        embeddedImageFiles[linkedFile.path] = linkedFile;
                    }
                } catch {
                    continue;
                }
            }
        }

        return embeddedImageFiles;
    }
}

const { Plugin, MarkdownRenderer } = require('obsidian');

module.exports = class HeadingAggregatorPlugin extends Plugin {
    async onload() {
        console.log('Loading Heading Aggregator plugin');

        // 注册代码块处理器
        this.registerMarkdownCodeBlockProcessor('heading-agg', async (source, el, ctx) => {
            await this.processHeadingAggregator(source, el, ctx);
        });
    }

    onunload() {
        console.log('Unloading Heading Aggregator plugin');
    }

    /**
     * 处理 heading-aggregator 代码块
     * @param {string} source - 代码块内容
     * @param {HTMLElement} el - 要渲染到的元素
     * @param {MarkdownPostProcessorContext} ctx - 上下文
     */
    async processHeadingAggregator(source, el, ctx) {
        try {
            // 解析参数
            const params = this.parseParams(source);
            const { heading, format = 'list', maxDepth = 10, strictLevel = false, matchMode = 'exact' } = params;

            if (!heading) {
                el.createEl('div', { 
                    text: '错误：请指定要聚合的标题（heading: "## 标题名"）',
                    cls: 'heading-agg-error'
                });
                return;
            }

            // 解析多个标题（支持逗号或竖线分隔）
            const headings = heading.split(/[,|]/).map(h => h.trim()).filter(h => h);

            // 显示加载状态
            const headingsText = headings.length > 1 ? `${headings.length} 个标题` : headings[0];
            el.createEl('div', { text: `正在聚合 ${headingsText} 的内容...`, cls: 'heading-agg-loading' });

            // 获取所有匹配的内容
            const results = await this.aggregateHeadingContent(headings, maxDepth, strictLevel, matchMode);

            // 清空元素
            el.empty();

            // 根据格式渲染结果
            if (results.length === 0) {
                const headingsText = headings.length > 1 ? headings.join('、') : headings[0];
                el.createEl('div', { 
                    text: `未找到标题 "${headingsText}" 的内容`,
                    cls: 'heading-agg-empty'
                });
                return;
            }

            // 根据不同格式渲染
            switch (format.toLowerCase()) {
                case 'table':
                    await this.renderAsTable(results, el, ctx);
                    break;
                case 'markdown':
                    await this.renderAsMarkdown(results, el, ctx);
                    break;
                case 'list':
                default:
                    await this.renderAsList(results, el, ctx);
                    break;
            }

        } catch (error) {
            el.empty();
            el.createEl('div', { 
                text: `错误：${error.message}`,
                cls: 'heading-agg-error'
            });
            console.error('Heading Aggregator error:', error);
        }
    }

    /**
     * 解析代码块参数
     * @param {string} source - YAML 格式的参数
     * @returns {Object} 解析后的参数对象
     */
    parseParams(source) {
        const params = {};
        const lines = source.trim().split('\n');
        
        for (const line of lines) {
            const match = line.match(/^\s*(\w+)\s*:\s*(.+)$/);
            if (match) {
                let key = match[1].trim();
                let value = match[2].trim();
                
                // 移除引号
                if ((value.startsWith('"') && value.endsWith('"')) || 
                    (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                
                // 转换数字
                if (!isNaN(value)) {
                    value = parseInt(value);
                }
                
                // 转换布尔值
                if (value === 'true') value = true;
                if (value === 'false') value = false;
                
                params[key] = value;
            }
        }
        
        return params;
    }

    /**
     * 聚合所有文件中指定标题下的内容
     * @param {Array|string} targetHeadings - 目标标题数组或单个标题（如 ["## 项目进度", "## introduction"]）
     * @param {number} maxDepth - 最大搜索深度
     * @param {boolean} strictLevel - 是否严格匹配标题级别
     * @param {string} matchMode - 匹配模式：'exact'（精确匹配）或 'partial'（部分匹配）
     * @returns {Array} 包含文件路径和内容的数组
     */
    async aggregateHeadingContent(targetHeadings, maxDepth, strictLevel = false, matchMode = 'exact') {
        const results = [];
        const files = this.app.vault.getMarkdownFiles();

        // 确保 targetHeadings 是数组
        if (!Array.isArray(targetHeadings)) {
            targetHeadings = [targetHeadings];
        }

        // 解析所有标题
        const parsedHeadings = [];
        for (const heading of targetHeadings) {
            const headingMatch = heading.match(/^(#{1,6})\s+(.+)$/);
            if (!headingMatch) {
                throw new Error(`标题格式错误："${heading}"，应该是 "# 标题" 或 "## 标题" 等格式`);
            }
            parsedHeadings.push({
                original: heading,
                level: headingMatch[1].length,
                text: headingMatch[2].trim()
            });
        }

        for (const file of files) {
            try {
                const content = await this.app.vault.read(file);
                const extracted = this.extractContentUnderHeadings(
                    content, 
                    parsedHeadings,
                    strictLevel,
                    matchMode
                );

                if (extracted && extracted.length > 0) {
                    for (const item of extracted) {
                        results.push({
                            file: file,
                            path: file.path,
                            content: item.content,
                            basename: file.basename,
                            matchedHeading: item.matchedHeading,
                            matchedLevel: item.matchedLevel
                        });
                    }
                }
            } catch (error) {
                console.error(`Error reading file ${file.path}:`, error);
            }
        }

        return results;
    }

    /**
     * 从文件内容中提取指定标题下的内容（支持多个标题）
     * @param {string} content - 文件内容
     * @param {Array} parsedHeadings - 解析后的标题数组 [{original, level, text}]
     * @param {boolean} strictLevel - 是否严格匹配标题级别
     * @param {string} matchMode - 匹配模式：'exact'（精确匹配）或 'partial'（部分匹配）
     * @returns {Array} 提取的内容数组，每个元素包含 {content, matchedHeading, matchedLevel}
     */
    extractContentUnderHeadings(content, parsedHeadings, strictLevel = false, matchMode = 'exact') {
        const lines = content.split('\n');
        let allResults = [];
        const headingRegex = /^(#{1,6})\s+(.+)$/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(headingRegex);

            if (match) {
                const level = match[1].length;
                const text = match[2].trim();

                // 检查是否匹配任何一个目标标题
                for (const targetHeading of parsedHeadings) {
                    let isMatch = false;
                    
                    if (matchMode === 'partial') {
                        // 部分匹配模式：标题包含目标文本即可
                        if (strictLevel) {
                            isMatch = (level === targetHeading.level && text.includes(targetHeading.text));
                        } else {
                            isMatch = text.includes(targetHeading.text);
                        }
                    } else {
                        // 精确匹配模式（默认）
                        if (strictLevel) {
                            isMatch = (level === targetHeading.level && text === targetHeading.text);
                        } else {
                            isMatch = (text === targetHeading.text);
                        }
                    }

                    if (isMatch) {
                        // 提取该标题下的内容
                        const sectionContent = [];
                        const currentLevel = level;
                        
                        for (let j = i + 1; j < lines.length; j++) {
                            const nextLine = lines[j];
                            const nextMatch = nextLine.match(headingRegex);
                            
                            if (nextMatch) {
                                const nextLevel = nextMatch[1].length;
                                // 遇到同级或更高级别的标题，停止
                                if (nextLevel <= currentLevel) {
                                    break;
                                }
                            }
                            
                            sectionContent.push(nextLine);
                        }
                        
                        if (sectionContent.length > 0) {
                            allResults.push({
                                content: sectionContent.join('\n').trim(),
                                matchedHeading: targetHeading.text,
                                matchedLevel: level
                            });
                        }
                        
                        // 找到匹配后跳出内层循环
                        break;
                    }
                }
            }
        }

        return allResults;
    }

    /**
     * 以列表格式渲染结果
     */
    async renderAsList(results, el, ctx) {
        const container = el.createEl('div', { cls: 'heading-agg-list' });
        
        for (const result of results) {
            const itemDiv = container.createEl('div', { cls: 'heading-agg-list-item' });
            
            // 文件链接和匹配标题
            const headerDiv = itemDiv.createEl('div', { cls: 'heading-agg-item-header' });
            const link = headerDiv.createEl('a', {
                text: result.basename,
                cls: 'internal-link heading-agg-file-link'
            });
            link.href = result.path;
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.app.workspace.openLinkText(result.path, '', false);
            });
            
            // 显示匹配的标题
            if (result.matchedHeading) {
                headerDiv.createEl('span', { 
                    text: ` • ${result.matchedHeading}`,
                    cls: 'heading-agg-matched-heading'
                });
            }
            
            // 内容
            const contentDiv = itemDiv.createEl('div', { cls: 'heading-agg-item-content' });
            await MarkdownRenderer.renderMarkdown(
                result.content,
                contentDiv,
                result.path,
                this
            );
        }
    }

    /**
     * 以表格格式渲染结果
     */
    async renderAsTable(results, el, ctx) {
        const container = el.createEl('div', { cls: 'heading-agg-table' });
        const table = container.createEl('table', { cls: 'heading-agg-table-view' });
        
        // 表头
        const thead = table.createEl('thead');
        const headerRow = thead.createEl('tr');
        headerRow.createEl('th', { text: '文件' });
        
        // 检查是否有多个标题
        const hasMultipleHeadings = results.some(r => r.matchedHeading);
        if (hasMultipleHeadings) {
            headerRow.createEl('th', { text: '匹配标题' });
        }
        
        headerRow.createEl('th', { text: '内容' });
        
        // 表体
        const tbody = table.createEl('tbody');
        for (const result of results) {
            const row = tbody.createEl('tr');
            
            // 文件名单元格
            const fileCell = row.createEl('td', { cls: 'heading-agg-table-file' });
            const link = fileCell.createEl('a', {
                text: result.basename,
                cls: 'internal-link'
            });
            link.href = result.path;
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.app.workspace.openLinkText(result.path, '', false);
            });
            
            // 匹配标题单元格（如果有）
            if (hasMultipleHeadings) {
                const headingCell = row.createEl('td', { 
                    text: result.matchedHeading || '',
                    cls: 'heading-agg-table-heading'
                });
            }
            
            // 内容单元格
            const contentCell = row.createEl('td', { cls: 'heading-agg-table-content' });
            await MarkdownRenderer.renderMarkdown(
                result.content,
                contentCell,
                result.path,
                this
            );
        }
    }

    /**
     * 以完整 Markdown 格式渲染结果
     */
    async renderAsMarkdown(results, el, ctx) {
        const container = el.createEl('div', { cls: 'heading-agg-markdown' });
        
        for (const result of results) {
            // 创建文件标题
            const heading = container.createEl('h3', { cls: 'heading-agg-markdown-title' });
            const link = heading.createEl('a', {
                text: result.basename,
                cls: 'internal-link'
            });
            link.href = result.path;
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.app.workspace.openLinkText(result.path, '', false);
            });
            
            // 显示匹配的标题
            if (result.matchedHeading) {
                heading.createEl('span', { 
                    text: ` • ${result.matchedHeading}`,
                    cls: 'heading-agg-matched-heading'
                });
            }
            
            // 渲染内容
            const contentDiv = container.createEl('div', { cls: 'heading-agg-markdown-content' });
            await MarkdownRenderer.renderMarkdown(
                result.content,
                contentDiv,
                result.path,
                this
            );
            
            // 添加分隔线
            if (result !== results[results.length - 1]) {
                container.createEl('hr', { cls: 'heading-agg-separator' });
            }
        }
    }
};

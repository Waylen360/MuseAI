import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Typography, Spin } from 'antd';
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  codeBlockPlugin,
  codeMirrorPlugin,
  CreateLink,
  headingsPlugin,
  imagePlugin,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  ListsToggle,
  markdownShortcutPlugin,
  MDXEditor,
  type MDXEditorMethods,
  quotePlugin,
  Separator,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';

interface MarkdownEditorProps {
  filePath: string | null;
  readOnly?: boolean;
}

type SaveStatus = 'saved' | 'saving' | 'error';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

const isImageFile = (path: string) => {
  const extension = path.split('.').pop()?.toLowerCase();
  return extension ? IMAGE_EXTENSIONS.includes(extension) : false;
};

const getDirectoryName = (path: string) => path.replace(/[\\/][^\\/]*$/, '');

const isExternalImageSrc = (src: string) => /^(?:[a-z]+:)?\/\//i.test(src) || src.startsWith('data:') || src.startsWith('#');

const normalizePath = (path: string) => {
  const absolute = path.startsWith('/');
  const parts = path.split('/').filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `${absolute ? '/' : ''}${stack.join('/')}`;
};

const resolveImageSrc = async (src: string, markdownPath: string) => {
  if (isExternalImageSrc(src)) {
    return src;
  }
  const absolutePath = src.startsWith('/')
    ? src
    : normalizePath(`${getDirectoryName(markdownPath)}/${src}`);
  return invoke<string>('read_image_data_url', { path: absolutePath });
};

const rewriteMarkdownImageLinks = async (markdown: string, markdownPath: string) => {
  const links: Record<string, string> = {};
  let rewritten = markdown;
  const markdownMatches = [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g)];
  for (const match of markdownMatches) {
    const [fullMatch, alt, src, title] = match;
    const nextSrc = await resolveImageSrc(src, markdownPath);
    if (nextSrc !== src) {
      links[nextSrc] = src;
    }
    rewritten = rewritten.replace(fullMatch, title ? `![${alt}](${nextSrc} "${title}")` : `![${alt}](${nextSrc})`);
  }

  const htmlMatches = [...rewritten.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)];
  for (const match of htmlMatches) {
    const [fullMatch, src] = match;
    const nextSrc = await resolveImageSrc(src, markdownPath);
    if (nextSrc !== src) {
      links[nextSrc] = src;
    }
    rewritten = rewritten.replace(fullMatch, `![图片](${nextSrc})`);
  }

  return { markdown: rewritten, links };
};

const restoreMarkdownImageLinks = (markdown: string, links: Record<string, string>) => {
  let restored = markdown;
  for (const [assetSrc, originalSrc] of Object.entries(links)) {
    restored = restored.split(assetSrc).join(originalSrc);
  }
  return restored;
};

const normalizeCopyText = (text: string) => text.replace(/\s+/g, '');

const findOriginalSelectionText = (needle: string, originalText: string) => {
  if (!needle) {
    return '';
  }

  const exactStart = originalText.indexOf(needle);
  if (exactStart !== -1) {
    return originalText.slice(exactStart, exactStart + needle.length);
  }

  const normalizedNeedle = normalizeCopyText(needle);
  if (!normalizedNeedle) {
    return '';
  }

  let normalizedOriginalText = '';
  const originalIndexes: number[] = [];
  for (let index = 0; index < originalText.length; index += 1) {
    if (/\s/.test(originalText[index])) {
      continue;
    }
    normalizedOriginalText += originalText[index];
    originalIndexes.push(index);
  }

  const start = normalizedOriginalText.indexOf(normalizedNeedle);
  if (start === -1) {
    return '';
  }

  const end = start + normalizedNeedle.length - 1;
  return originalText.slice(originalIndexes[start], originalIndexes[end] + 1);
};

const isSelectionCoveringElement = (selection: Selection, element: Element) => {
  if (selection.rangeCount === 0) {
    return false;
  }

  const selectionRange = selection.getRangeAt(0);
  const elementRange = document.createRange();
  elementRange.selectNodeContents(element);
  try {
    return (
      selectionRange.compareBoundaryPoints(Range.START_TO_START, elementRange) <= 0
      && selectionRange.compareBoundaryPoints(Range.END_TO_END, elementRange) >= 0
    );
  } finally {
    elementRange.detach();
  }
};

const MarkdownEditor: React.FC<MarkdownEditorProps> = ({ filePath, readOnly = false }) => {
  const [content, setContent] = useState<string>('');
  const [displayContent, setDisplayContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [imagePreviewSrc, setImagePreviewSrc] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [readError, setReadError] = useState(false);
  const editorRef = useRef<MDXEditorMethods>(null);
  const editorShellRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollRestoreFrameRef = useRef<number | null>(null);
  const imageLinkMapRef = useRef<Record<string, string>>({});
  const latestContentRef = useRef(content);
  const savedContentRef = useRef(savedContent);
  const loadingRef = useRef(loading);
  const readErrorRef = useRef(readError);
  const lastKnownModifiedAtRef = useRef<number | null>(null);
  const fullSelectionIntentUntilRef = useRef(0);
  const editorPlugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      imagePlugin({
        disableImageResize: true,
        disableImageSettingsButton: true,
        EditImageToolbar: () => null,
      }),
      codeBlockPlugin({ defaultCodeBlockLanguage: 'txt' }),
      codeMirrorPlugin({
        autoLoadLanguageSupport: false,
        codeBlockLanguages: {
          txt: '文本',
          bash: 'Bash',
          shell: 'Shell',
          sh: 'Shell',
          js: 'JavaScript',
          javascript: 'JavaScript',
          ts: 'TypeScript',
          typescript: 'TypeScript',
          json: 'JSON',
          markdown: 'Markdown',
          md: 'Markdown',
        },
      }),
      tablePlugin(),
      thematicBreakPlugin(),
      markdownShortcutPlugin(),
      toolbarPlugin({
        toolbarContents: () => (
          <>
            <UndoRedo />
            <Separator />
            <BlockTypeSelect />
            <BoldItalicUnderlineToggles />
            <ListsToggle />
            <Separator />
            <CreateLink />
            <InsertImage />
            <InsertTable />
            <InsertThematicBreak />
          </>
        ),
      }),
    ],
    []
  );

  useEffect(() => {
    latestContentRef.current = content;
  }, [content]);

  useEffect(() => {
    savedContentRef.current = savedContent;
  }, [savedContent]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    readErrorRef.current = readError;
  }, [readError]);

  useEffect(() => {
    let mounted = true;
    if (!filePath) {
      setContent('');
      setDisplayContent('');
      setSavedContent('');
      setImagePreviewSrc('');
      lastKnownModifiedAtRef.current = null;
      return () => {
        mounted = false;
      };
    }
    if (isImageFile(filePath)) {
      setContent('');
      setDisplayContent('');
      setSavedContent('');
      setImagePreviewSrc('');
      setSaveStatus('saved');
      setReadError(false);
      lastKnownModifiedAtRef.current = null;
      setLoading(true);
      invoke<string>('read_image_data_url', { path: filePath })
        .then((src) => {
          if (mounted) {
            setImagePreviewSrc(src);
            setLoading(false);
          }
        })
        .catch((err) => {
          console.error('Error reading image:', err);
          if (mounted) {
            setReadError(true);
            setContent(`**读取图片失败**: ${err}`);
            setLoading(false);
          }
        });
      return () => {
        mounted = false;
      };
    }
    setLoading(true);
    Promise.all([
      invoke<string>('read_file', { path: filePath }),
      invoke<number>('file_modified_at', { path: filePath }),
    ])
      .then(async ([text, modifiedAt]) => {
        const rewritten = await rewriteMarkdownImageLinks(text, filePath);
        if (mounted) {
          imageLinkMapRef.current = rewritten.links;
          setContent(text);
          setDisplayContent(rewritten.markdown);
          setSavedContent(text);
          editorRef.current?.setMarkdown(rewritten.markdown);
          lastKnownModifiedAtRef.current = modifiedAt;
          setSaveStatus('saved');
          setReadError(false);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('Error reading file:', err);
        if (mounted) {
          setContent(`**读取文件失败**: ${err}`);
          setSavedContent('');
          setSaveStatus('error');
          setReadError(true);
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [filePath]);

  useEffect(() => {
    if (!filePath || isImageFile(filePath)) {
      return;
    }

    const pollTimer = window.setInterval(() => {
      if (loadingRef.current || readErrorRef.current || latestContentRef.current !== savedContentRef.current) {
        return;
      }

      invoke<number>('file_modified_at', { path: filePath })
        .then((modifiedAt) => {
          if (lastKnownModifiedAtRef.current === null) {
            lastKnownModifiedAtRef.current = modifiedAt;
            return;
          }

          if (modifiedAt === lastKnownModifiedAtRef.current) {
            return;
          }

          return invoke<string>('read_file', { path: filePath }).then(async (text) => {
            if (latestContentRef.current !== savedContentRef.current) {
              return;
            }

            const rewritten = await rewriteMarkdownImageLinks(text, filePath);
            imageLinkMapRef.current = rewritten.links;
            setContent(text);
            setDisplayContent(rewritten.markdown);
            setSavedContent(text);
            editorRef.current?.setMarkdown(rewritten.markdown);
            lastKnownModifiedAtRef.current = modifiedAt;
            setSaveStatus('saved');
          });
        })
        .catch((err) => {
          console.error('Error checking file updates:', err);
        });
    }, 1200);

    return () => {
      window.clearInterval(pollTimer);
    };
  }, [filePath]);

  const handleCopy = useCallback((event: ClipboardEvent | React.ClipboardEvent<HTMLDivElement>) => {
    const editorShell = editorShellRef.current;
    const selection = document.getSelection();
    if (!editorShell || !selection || selection.isCollapsed) {
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const selectionStartsInEditor = anchorNode ? editorShell.contains(anchorNode) : false;
    const selectionEndsInEditor = focusNode ? editorShell.contains(focusNode) : false;
    if (!selectionStartsInEditor && !selectionEndsInEditor) {
      return;
    }

    const originalText = latestContentRef.current || savedContentRef.current;
    const selectedMarkdown = editorRef.current?.getSelectionMarkdown();
    const restoredSelectedMarkdown = selectedMarkdown
      ? restoreMarkdownImageLinks(selectedMarkdown, imageLinkMapRef.current)
      : '';
    const selectedText = selection.toString().trim();
    const editorContent = editorShell.querySelector('.muse-mdx-content');
    const copiedAfterSelectAll = Date.now() <= fullSelectionIntentUntilRef.current;
    const isFullEditorSelection = Boolean(
      originalText
      && (
        copiedAfterSelectAll
        || (editorContent && isSelectionCoveringElement(selection, editorContent))
      )
    );
    fullSelectionIntentUntilRef.current = 0;
    const textToCopy = isFullEditorSelection
      ? originalText
      : findOriginalSelectionText(restoredSelectedMarkdown, originalText)
      || findOriginalSelectionText(selectedText, originalText)
      || restoredSelectedMarkdown
      || selectedText;

    if (!textToCopy) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if ('nativeEvent' in event) {
      event.nativeEvent.stopImmediatePropagation();
    } else {
      event.stopImmediatePropagation();
    }
    event.clipboardData?.setData('text/plain', textToCopy);
    event.clipboardData?.setData('text/markdown', textToCopy);
  }, []);

  const handleEditorKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    if (!target || !editorShellRef.current?.contains(target)) {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      fullSelectionIntentUntilRef.current = Date.now() + 5000;
    }
  }, []);

  useEffect(() => {
    const handleToolbarPointer = (event: Event) => {
      const target = event.target as Element | null;
      if (!target?.closest('.mdxeditor-toolbar, .mdxeditor-popup-container')) {
        return;
      }

      const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
      restoreScrollPosition(scrollTop);
    };

    document.addEventListener('copy', handleCopy, true);
    document.addEventListener('pointerdown', handleToolbarPointer, true);
    document.addEventListener('click', handleToolbarPointer, true);

    return () => {
      document.removeEventListener('copy', handleCopy, true);
      document.removeEventListener('pointerdown', handleToolbarPointer, true);
      document.removeEventListener('click', handleToolbarPointer, true);
      if (scrollRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollRestoreFrameRef.current);
      }
    };
  }, [handleCopy]);

  useEffect(() => {
    if (!filePath || isImageFile(filePath) || loading || readError || content === savedContent) {
      return;
    }

    const pathToSave = filePath;
    const contentToSave = content;
    setSaveStatus('saving');

    const saveTimer = window.setTimeout(() => {
      invoke<number>('write_file', { path: pathToSave, content: contentToSave })
        .then((modifiedAt) => {
          setSavedContent(contentToSave);
          lastKnownModifiedAtRef.current = modifiedAt;
          if (latestContentRef.current === contentToSave) {
            setSaveStatus('saved');
          }
        })
        .catch((err) => {
          console.error('Error writing file:', err);
          setSaveStatus('error');
        });
    }, 800);

    return () => {
      window.clearTimeout(saveTimer);
    };
  }, [content, filePath, loading, readError, savedContent]);

  const restoreScrollPosition = (scrollTop: number) => {
    const restoreUntil = Date.now() + 1200;

    if (scrollRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollRestoreFrameRef.current);
    }

    const restore = () => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = scrollTop;
      }

      if (Date.now() < restoreUntil) {
        scrollRestoreFrameRef.current = window.requestAnimationFrame(restore);
      } else {
        scrollRestoreFrameRef.current = null;
      }
    };

    restore();
  };

  if (!filePath) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#999' }}>
        <Typography.Text type="secondary">选择左侧文件以开始阅读或编辑</Typography.Text>
      </div>
    );
  }

  if (isImageFile(filePath)) {
    return (
      <div style={{ height: '100%', overflow: 'auto', padding: '32px 48px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#faf9f5' }}>
        <img
          src={imagePreviewSrc}
          alt={filePath.split(/[\\/]/).pop() || '图片预览'}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8 }}
        />
      </div>
    );
  }

  return (
    <div ref={scrollContainerRef} style={{ height: '100%', overflowY: 'auto', padding: '32px 48px' }}>
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <Spin />
        </div>
      ) : (
        <div
          className="markdown-editor-shell"
          ref={editorShellRef}
          onCopyCapture={handleCopy}
          onKeyDownCapture={handleEditorKeyDown}
        >
          <div className="markdown-save-status">
            {saveStatus === 'saving' ? '保存中' : saveStatus === 'error' ? '保存失败' : '已保存'}
          </div>
          <MDXEditor
            ref={editorRef}
            className="muse-mdx-editor"
            contentEditableClassName="muse-mdx-content"
            markdown={displayContent}
            readOnly={readOnly}
            onChange={(markdown) => {
              if (!readOnly) {
                setContent(restoreMarkdownImageLinks(markdown, imageLinkMapRef.current));
                setDisplayContent(markdown);
              }
            }}
            placeholder="开始写作..."
            spellCheck={false}
            plugins={editorPlugins}
          />
        </div>
      )}
    </div>
  );
};

export default MarkdownEditor;

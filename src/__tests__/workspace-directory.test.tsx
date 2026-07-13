import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WorkspaceDirectory from '../components/WorkspaceDirectory';

const invokeMock = vi.fn(async (command: string, args?: { path?: string }) => {
  if (command === 'get_workspace_dir') return '/Users/test/Documents/MuseAI/articles';
  if (command === 'list_dir' && args?.path === '/Users/test/Documents/MuseAI/articles') {
    return [
      { name: '章节', path: '/Users/test/Documents/MuseAI/articles/章节', is_dir: true },
      { name: '首页.md', path: '/Users/test/Documents/MuseAI/articles/首页.md', is_dir: false },
    ];
  }
  if (command === 'list_dir' && args?.path === '/Users/test/Documents/MuseAI/articles/章节') {
    return [
      { name: '第一章.md', path: '/Users/test/Documents/MuseAI/articles/章节/第一章.md', is_dir: false },
    ];
  }
  return undefined;
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args as { path?: string }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

describe('WorkspaceDirectory', () => {
  it('只为展开目录加载子节点并保留文件选择行为', async () => {
    const onSelectFile = vi.fn();
    render(
      <WorkspaceDirectory
        title="作品目录"
        dirType="articles"
        selectedFile={null}
        onSelectFile={onSelectFile}
      />,
    );

    expect(await screen.findByText('章节')).toBeInTheDocument();
    expect(screen.getByText('首页.md')).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith('list_dir', {
      path: '/Users/test/Documents/MuseAI/articles/章节',
    });

    const directoryNode = screen.getByText('章节').closest('.ant-tree-treenode');
    fireEvent.click(directoryNode?.querySelector('.ant-tree-switcher') as HTMLElement);

    expect(await screen.findByText('第一章.md')).toBeInTheDocument();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('list_dir', {
        path: '/Users/test/Documents/MuseAI/articles/章节',
      });
    });

    fireEvent.click(screen.getByText('第一章.md'));
    expect(onSelectFile).toHaveBeenCalledWith('/Users/test/Documents/MuseAI/articles/章节/第一章.md');
  });
});

import React, { useState, useEffect, useRef } from 'react';
import { Tree, Typography, Spin, Button, Tooltip, message, Dropdown, Modal, Input } from 'antd';
import { FolderOutlined, FileTextOutlined, FolderOpenOutlined, EditOutlined, PlusOutlined, FolderAddOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

const { Text } = Typography;
const { DirectoryTree } = Tree;

interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
}

interface TreeItem {
  title: React.ReactNode;
  key: string;
  path: string;
  name: string;
  isDir: boolean;
  isLeaf: boolean;
  icon: React.ReactNode;
  children?: TreeItem[];
  pending?: boolean;
}

interface EditingNode {
  path: string;
  parentPath: string;
  originalName: string;
  value: string;
  kind: 'create-file' | 'create-folder' | 'rename';
  isDir: boolean;
}

interface FileExplorerProps {
  onSelectFile: (path: string | null) => void;
  selectedDirectory: string | null;
  onSelectDirectory: (path: string | null) => void;
  workspacePath: string | null;
  onChangeWorkspace: (path: string | null) => void;
  expandedKeys: React.Key[];
  onExpandedKeysChange: (keys: React.Key[]) => void;
}

const FileExplorer: React.FC<FileExplorerProps> = ({
  onSelectFile,
  selectedDirectory,
  onSelectDirectory,
  workspacePath,
  onChangeWorkspace,
  expandedKeys,
  onExpandedKeysChange
}) => {
  const [treeData, setTreeData] = useState<TreeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingNode, setEditingNode] = useState<EditingNode | null>(null);
  const editingNodeRef = useRef<EditingNode | null>(null);
  const expandedKeysRef = useRef(expandedKeys);
  const isCommittingEditRef = useRef(false);

  useEffect(() => {
    expandedKeysRef.current = expandedKeys;
  }, [expandedKeys]);

  const refreshRoot = async (path: string, showLoading = true) => {
    if (showLoading) {
      setLoading(true);
    }
    let data = await loadDirectory(path);
    const currentExpandedKeys = expandedKeysRef.current;
    for (const key of currentExpandedKeys) {
      if (typeof key !== 'string') continue;
      const children = await loadDirectory(key);
      data = updateTreeData(data, key, children);
    }
    setTreeData(data);
    if (showLoading) {
      setLoading(false);
    }
  };

  const renderNodeTitle = (node: FileNode | TreeItem, options?: { pending?: boolean }) => {
    const isEditing = editingNode?.path === node.path;
    if (isEditing && editingNode) {
      return (
        <Input
          autoFocus
          defaultValue={editingNode.value}
          size="small"
          onBlur={(event) => commitEditing(event.currentTarget.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              commitEditing(event.currentTarget.value);
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelEditing();
            }
          }}
          style={{ height: 24, padding: '0 6px', fontSize: 13 }}
        />
      );
    }

    return (
      <Dropdown
        menu={{
          items: [
            { key: 'copy-absolute', label: '复制绝对路径' },
            { key: 'copy-relative', label: '复制基于工作空间的相对路径' },
            { key: 'rename', label: '重命名' },
            { key: 'delete', label: '删除', danger: true },
          ],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            void handleContextAction(String(key), {
              name: node.name,
              path: node.path,
              is_dir: 'is_dir' in node ? node.is_dir : node.isDir,
            });
          },
        }}
        trigger={options?.pending ? [] : ['contextMenu']}
      >
        <span className="file-tree-title" title={node.name} onContextMenu={(event) => event.stopPropagation()}>
          {node.name}
        </span>
      </Dropdown>
    );
  };

  const toTreeItem = (node: FileNode, options?: { pending?: boolean }): TreeItem => ({
    title: renderNodeTitle(node, options),
    key: node.path,
    path: node.path,
    name: node.name,
    isDir: node.is_dir,
    isLeaf: !node.is_dir,
    icon: node.is_dir ? <FolderOutlined /> : <FileTextOutlined />,
    pending: options?.pending,
  });

  const hydrateTitles = (list: TreeItem[]): TreeItem[] =>
    list.map((node) => ({
      ...node,
      title: renderNodeTitle(node, { pending: node.pending }),
      children: node.children ? hydrateTitles(node.children) : undefined,
    }));

  const loadDirectory = async (path: string): Promise<TreeItem[]> => {
    try {
      const nodes: FileNode[] = await invoke('list_dir', { path });
      return nodes.map((node) => toTreeItem(node));
    } catch (err) {
      console.error('Failed to load directory:', err);
      return [];
    }
  };

  useEffect(() => {
    let mounted = true;
    if (!workspacePath) {
      setTreeData([]);
      return;
    }

    refreshRoot(workspacePath).then(() => {
      if (mounted) {
        setLoading(false);
      }
    });

    const unlistenPromise = listen('workspace-changed', () => {
      if (mounted && workspacePath) {
        void refreshRoot(workspacePath, false);
      }
    });

    return () => {
      mounted = false;
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [workspacePath]);

  const onLoadData = async ({ key, children }: any) => {
    if (children) {
      return;
    }
    const nodes = await loadDirectory(key);
    setTreeData((origin) =>
      updateTreeData(origin, key, nodes)
    );
  };

  useEffect(() => {
    editingNodeRef.current = editingNode;
    setTreeData((origin) => hydrateTitles(origin));
  }, [editingNode]);

  const updateTreeData = (list: TreeItem[], key: React.Key, children: TreeItem[]): TreeItem[] =>
    list.map((node) => {
      if (node.key === key) {
        return {
          ...node,
          children,
        };
      }
      if (node.children) {
        return {
          ...node,
          children: updateTreeData(node.children, key, children),
        };
      }
      return node;
    });

  const appendTreeItem = (list: TreeItem[], parentKey: string, item: TreeItem): TreeItem[] => {
    if (parentKey === workspacePath) {
      return [...list, item];
    }
    return list.map((node) => {
      if (node.key === parentKey) {
        return {
          ...node,
          children: [...(node.children ?? []), item],
        };
      }
      if (node.children) {
        return {
          ...node,
          children: appendTreeItem(node.children, parentKey, item),
        };
      }
      return node;
    });
  };

  const removeTreeItem = (list: TreeItem[], key: string): TreeItem[] =>
    list
      .filter((node) => node.key !== key)
      .map((node) => ({
        ...node,
        children: node.children ? removeTreeItem(node.children, key) : undefined,
      }));

  const findChildren = (list: TreeItem[], parentKey: string): TreeItem[] => {
    if (parentKey === workspacePath) {
      return list;
    }
    for (const node of list) {
      if (node.key === parentKey) {
        return node.children ?? [];
      }
      if (node.children) {
        const result = findChildren(node.children, parentKey);
        if (result.length > 0) {
          return result;
        }
      }
    }
    return [];
  };

  const buildUniqueName = (parentKey: string, baseName: string, extension = '') => {
    const existingNames = new Set(findChildren(treeData, parentKey).map((node) => node.name));
    const firstName = `${baseName}${extension}`;
    if (!existingNames.has(firstName)) {
      return firstName;
    }

    for (let index = 2; index <= 99; index += 1) {
      const nextName = `${baseName} ${index}${extension}`;
      if (!existingNames.has(nextName)) {
        return nextName;
      }
    }

    return `${baseName} ${Date.now()}${extension}`;
  };

  const handleSelectFolder = async () => {
    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
      });
      if (selectedPath && typeof selectedPath === 'string') {
        onChangeWorkspace(selectedPath);
      }
    } catch (err) {
      console.error('Failed to open dialog:', err);
    }
  };

  const parentPathOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '');

  const activeCreateDirectory = selectedDirectory || workspacePath;

  const buildPath = (parentPath: string, name: string) => `${parentPath}/${name}`;

  const relativeToWorkspace = (path: string) => {
    if (!workspacePath) return path;
    if (path === workspacePath) return '.';
    return path.startsWith(`${workspacePath}/`) ? path.slice(workspacePath.length + 1) : path;
  };

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
    message.success('已复制路径');
  };

  const handleContextAction = async (action: string, node: FileNode) => {
    if (action === 'copy-absolute') {
      await copyText(node.path);
      return;
    }
    if (action === 'copy-relative') {
      await copyText(relativeToWorkspace(node.path));
      return;
    }
    if (action === 'rename') {
      setEditingNode({
        path: node.path,
        parentPath: parentPathOf(node.path),
        originalName: node.name,
        value: node.name,
        kind: 'rename',
        isDir: node.is_dir,
      });
      return;
    }
    if (action === 'delete') {
      Modal.confirm({
        title: '确认删除',
        content: `确定要删除“${node.name}”吗？`,
        okText: '删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          await invoke('delete_path', { path: node.path });
          if (!node.is_dir) {
            onSelectFile(null);
          }
          if (selectedDirectory && (selectedDirectory === node.path || selectedDirectory.startsWith(`${node.path}/`))) {
            onSelectDirectory(workspacePath);
          }
          setTreeData((origin) => removeTreeItem(origin, node.path));
          message.success('已删除');
        },
      });
    }
  };

  const createUniqueItem = async (kind: 'file' | 'folder') => {
    if (!workspacePath || !activeCreateDirectory) return;

    const baseName = kind === 'file' ? '新建文件' : '新建文件夹';
    const extension = kind === 'file' ? '.md' : '';
    const itemName = buildUniqueName(activeCreateDirectory, baseName, extension);
    const itemPath = buildPath(activeCreateDirectory, itemName);
    try {
      if (kind === 'file') {
        await invoke<number>('create_file', { path: itemPath });
        onSelectFile(itemPath);
        onSelectDirectory(activeCreateDirectory);
        message.success('已创建文件');
      } else {
        await invoke('create_dir', { path: itemPath });
        onSelectDirectory(itemPath);
        message.success('已创建文件夹');
      }

      if (!expandedKeys.includes(activeCreateDirectory)) {
        onExpandedKeysChange([...expandedKeys, activeCreateDirectory]);
      }
      await refreshRoot(workspacePath, false);
    } catch (err) {
      message.error(`${kind === 'file' ? '创建文件' : '创建文件夹'}失败: ${err}`);
    }
  };

  const cancelEditing = () => {
    if (editingNode?.kind.startsWith('create')) {
      setTreeData((origin) => removeTreeItem(origin, editingNode.path));
    }
    setEditingNode(null);
  };

  const commitEditing = async (rawName: string) => {
    const currentEditingNode = editingNodeRef.current;
    if (!currentEditingNode || isCommittingEditRef.current) return;
    isCommittingEditRef.current = true;
    const name = rawName.trim();
    if (!name) {
      isCommittingEditRef.current = false;
      cancelEditing();
      return;
    }

    if (currentEditingNode.kind === 'rename' && name === currentEditingNode.originalName) {
      isCommittingEditRef.current = false;
      setEditingNode(null);
      return;
    }

    try {
      if (currentEditingNode.kind === 'rename') {
        const newPath = await invoke<string>('rename_path', { path: currentEditingNode.path, newName: name });
        if (currentEditingNode.isDir) {
          onSelectDirectory(newPath);
        } else {
          onSelectFile(newPath);
          onSelectDirectory(parentPathOf(newPath));
        }
      } else {
        const path = buildPath(currentEditingNode.parentPath, name);
        if (currentEditingNode.kind === 'create-file') {
          await invoke<number>('create_file', { path });
          onSelectFile(path);
          onSelectDirectory(currentEditingNode.parentPath);
        } else {
          await invoke('create_dir', { path });
          onSelectDirectory(path);
        }
      }
      setEditingNode(null);
      await refreshRoot(workspacePath!, false);
    } catch (err) {
      message.error(String(err));
      if (currentEditingNode.kind.startsWith('create')) {
        cancelEditing();
      }
    } finally {
      isCommittingEditRef.current = false;
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '16px 16px 8px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <Text type="secondary" style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase' }}>
          作品目录
        </Text>
        {workspacePath && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Tooltip title="创建文件">
              <Button
                type="text"
                size="small"
                icon={<PlusOutlined />}
                onClick={() => createUniqueItem('file')}
                style={{ color: '#888' }}
              />
            </Tooltip>
            <Tooltip title="创建文件夹">
              <Button
                type="text"
                size="small"
                icon={<FolderAddOutlined />}
                onClick={() => createUniqueItem('folder')}
                style={{ color: '#888' }}
              />
            </Tooltip>
            <Tooltip title="更改目录">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={handleSelectFolder}
                style={{ color: '#888' }}
              />
            </Tooltip>
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
        {!workspacePath ? (
          <div style={{ padding: '40px 16px', textAlign: 'center' }}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
              当前未选择任何作品目录
            </Text>
            <Button
              type="primary"
              icon={<FolderOpenOutlined />}
              onClick={handleSelectFolder}
              style={{ backgroundColor: '#d97757', borderColor: '#d97757' }}
            >
              选择文件夹
            </Button>
          </div>
        ) : loading ? (
          <div style={{ padding: 16, textAlign: 'center' }}>
            <Spin size="small" />
          </div>
        ) : (
          <DirectoryTree
            expandAction={false}
            loadData={onLoadData}
            treeData={treeData}
            expandedKeys={expandedKeys}
            onExpand={(keys) => onExpandedKeysChange([...keys])}
            showIcon
            onSelect={(selectedKeys, e) => {
              const key = e.node.key as string;
              if (e.node.isLeaf && selectedKeys.length > 0) {
                onSelectFile(key);
                onSelectDirectory(parentPathOf(key));
              } else {
                onSelectDirectory(key);
                onExpandedKeysChange(
                  expandedKeys.includes(key)
                    ? expandedKeys.filter((item) => item !== key)
                    : [...expandedKeys, key]
                );
              }
            }}
            style={{ background: 'transparent' }}
          />
        )}
      </div>
    </div>
  );
};

export default FileExplorer;

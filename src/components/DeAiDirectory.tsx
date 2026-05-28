import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Tree, Button, Space, message, Modal, Dropdown, Input } from 'antd';
import { open } from '@tauri-apps/plugin-dialog';
import { PlusOutlined, FolderAddOutlined } from '@ant-design/icons';
import { useDeAiStore } from '../stores/useDeAiStore';

interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
}

interface DeAiDirectoryProps {
  title: string;
  isReference: boolean;
}

const DeAiDirectory: React.FC<DeAiDirectoryProps> = ({ title, isReference }) => {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  
  const { 
    selectedWorkFile, 
    selectedReferenceFile, 
    setSelectedWorkFile, 
    setSelectedReferenceFile 
  } = useDeAiStore();

  const selectedFile = isReference ? selectedReferenceFile : selectedWorkFile;
  const setSelectedFile = isReference ? setSelectedReferenceFile : setSelectedWorkFile;

  const loadFiles = async () => {
    try {
      const dir: string = await invoke('get_de_ai_dir', { isReference });
      const rootItems: FileNode[] = await invoke('list_dir', { path: dir });
      
      const fetchChildren = async (items: FileNode[]): Promise<FileNode[]> => {
        return Promise.all(items.map(async item => {
          if (item.is_dir && expandedKeys.includes(item.path)) {
            try {
              const children = await invoke<FileNode[]>('list_dir', { path: item.path });
              item.children = await fetchChildren(children.filter(i => i.name !== '.versions'));
            } catch (e) {
              item.children = [];
            }
          }
          return item;
        }));
      };
      
      const newNodes = await fetchChildren(rootItems.filter(i => i.name !== '.versions'));
      setNodes(newNodes);
    } catch (e) {
      console.error(e);
      message.error('加载文件失败');
    }
  };

  useEffect(() => {
    loadFiles();
  }, [expandedKeys]);

  const handleImport = async (isDirectory: boolean) => {
    try {
      const selected = await open({
        directory: isDirectory,
        multiple: false,
        filters: isDirectory ? undefined : [{ name: '文档和图片', extensions: ['md', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }],
      });
      
      if (!selected) return;

      const sourcePath = typeof selected === 'string' ? selected : selected[0];
      
      await invoke('import_de_ai_item', {
        sourcePath,
        isReference,
      });
      
      message.success('导入成功');
      loadFiles();
    } catch (e) {
      console.error(e);
      message.error(`导入失败: ${e}`);
    }
  };

  const handleDelete = (path: string) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该文件/文件夹吗？',
      onOk: async () => {
        try {
          await invoke('delete_de_ai_item', { itemPath: path });
          if (selectedFile === path) {
            setSelectedFile(null);
          }
          message.success('删除成功');
          loadFiles();
        } catch (e) {
          message.error(`删除失败: ${e}`);
        }
      }
    });
  };

  const handleRenameSubmit = async (path: string, oldName: string, newNameStr: string) => {
    setRenamingKey(null);
    if (!newNameStr || newNameStr === oldName) return;
    try {
      await invoke('rename_item', { path, newName: newNameStr });
      if (selectedFile === path) {
         const parts = path.split(/[\\/]/);
         parts.pop();
         setSelectedFile(parts.join('/') + '/' + newNameStr);
      }
      message.success('重命名成功');
      loadFiles(); // reload entire tree to simplify
    } catch (e) {
      message.error(`重命名失败: ${e}`);
    }
  };

  const handleDrop = async (info: any) => {
    const dragKey = info.dragNode.key as string;
    const dropKey = info.node.key as string;
    
    let targetDir = dropKey;
    if (!info.dropToGap) {
        if (!info.node.isLeaf) {
            targetDir = dropKey;
        } else {
            const parts = dropKey.split(/[\\/]/);
            parts.pop();
            targetDir = parts.join('/');
        }
    } else {
        const parts = dropKey.split(/[\\/]/);
        parts.pop();
        targetDir = parts.join('/');
    }

    if (targetDir === dragKey || targetDir.startsWith(dragKey + '/')) {
      message.error('无法移动到该目标位置');
      return;
    }
    
    const sourceParts = dragKey.split(/[\\/]/);
    sourceParts.pop();
    const sourceDir = sourceParts.join('/');
    
    if (sourceDir === targetDir) {
      message.warning('文件已在该目录下，如需手动排序请使用其他功能');
      return;
    }

    try {
        await invoke('move_item', { source: dragKey, targetDir });
        message.success('移动成功');
        loadFiles();
    } catch (e) {
        message.error(`移动失败: ${e}`);
    }
  };

  const updateTreeData = (list: FileNode[], key: React.Key, children: FileNode[]): FileNode[] =>
    list.map((node) => {
      if (node.path === key) {
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

  const handleLoadData = async ({ key, children }: any) => {
    if (children && children.length > 0) {
      return;
    }
    const items: FileNode[] = await invoke('list_dir', { path: key });
    setNodes((origin) => updateTreeData(origin, key, items.filter(item => item.name !== '.versions')));
  };

  const mapToTreeData = (files: FileNode[]): any[] => {
    return files.map(file => {
      const isRenaming = renamingKey === file.path;
      return {
        title: isRenaming ? (
          <Input 
            autoFocus
            defaultValue={file.name}
            size="small"
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => handleRenameSubmit(file.path, file.name, e.target.value)}
            onPressEnter={(e) => handleRenameSubmit(file.path, file.name, (e.target as any).value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setRenamingKey(null);
                e.stopPropagation();
              }
            }}
          />
        ) : (
          <Dropdown
            menu={{
              items: [
                { key: 'rename', label: '重命名', onClick: (e) => { e.domEvent.stopPropagation(); setRenamingKey(file.path); } },
                { key: 'delete', label: '删除', danger: true, onClick: (e) => { e.domEvent.stopPropagation(); handleDelete(file.path); } }
              ]
            }}
            trigger={['contextMenu']}
          >
            <div style={{ width: '100%' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {file.name}
              </span>
            </div>
          </Dropdown>
        ),
        key: file.path,
      isLeaf: !file.is_dir,
      children: file.children ? mapToTreeData(file.children) : undefined,
      };
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ color: '#d97757', fontSize: 14 }}>{title}</strong>
        <Space size="small">
          <Button size="small" icon={<PlusOutlined />} onClick={() => handleImport(false)} title="导入文件" />
          <Button size="small" icon={<FolderAddOutlined />} onClick={() => handleImport(true)} title="导入文件夹" />
        </Space>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {nodes.length > 0 ? (
          <Tree
            draggable={{ icon: false }}
            onDrop={handleDrop}
            treeData={mapToTreeData(nodes)}
            loadData={handleLoadData}
            selectedKeys={selectedFile ? [selectedFile] : []}
            expandedKeys={expandedKeys}
            onExpand={(keys) => setExpandedKeys([...keys])}
            onSelect={(selectedKeys, info) => {
              const key = info.node.key as string;
              if (info.node.isLeaf && selectedKeys.length > 0) {
                setSelectedFile(key);
              } else {
                setExpandedKeys((keys) =>
                  keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key]
                );
              }
            }}
            blockNode
            style={{ background: 'transparent' }}
          />
        ) : (
          <div style={{ color: '#999', textAlign: 'center', marginTop: 20, fontSize: 12 }}>
            暂无文件，请导入
          </div>
        )}
      </div>
    </div>
  );
};

export default DeAiDirectory;

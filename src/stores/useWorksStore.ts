import { create } from 'zustand';
import type { Key } from 'react';

interface WorksState {
  selectedFile: string | null;
  selectedDirectory: string | null;
  fileTreeWidth: number;
  agentWidth: number;
  isAgentVisible: boolean;
  expandedKeys: Key[];
  setSelectedFile: (file: string | null) => void;
  setSelectedDirectory: (directory: string | null) => void;
  setFileTreeWidth: (width: number) => void;
  setAgentWidth: (width: number) => void;
  setIsAgentVisible: (visible: boolean) => void;
  setExpandedKeys: (keys: Key[]) => void;
}

export const useWorksStore = create<WorksState>((set) => ({
  selectedFile: null,
  selectedDirectory: null,
  fileTreeWidth: 250,
  agentWidth: 420,
  isAgentVisible: true,
  expandedKeys: [],
  setSelectedFile: (selectedFile) => set({ selectedFile }),
  setSelectedDirectory: (selectedDirectory) => set({ selectedDirectory }),
  setFileTreeWidth: (fileTreeWidth) => set({ fileTreeWidth }),
  setAgentWidth: (agentWidth) => set({ agentWidth }),
  setIsAgentVisible: (isAgentVisible) => set({ isAgentVisible }),
  setExpandedKeys: (expandedKeys) => set({ expandedKeys }),
}));

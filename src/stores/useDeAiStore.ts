import { create } from 'zustand';
import { Message } from './useAgentStore';

interface AgentRunState {
  runId: string | null;
  messageId: string | null;
}

interface DeAiState {
  selectedWorkFile: string | null;
  selectedReferenceFile: string | null;
  activePreviewFile: string | null;
  activeVersionId: string | null;
  versions: any[];
  suggestion: string | null;
  aiScore: number | null;
  autoLoopCount: number;
  isAutoLooping: boolean;
  detectorRunning: boolean;
  removerRunning: boolean;
  detectorMessages: Message[];
  removerMessages: Message[];
  detectorRun: AgentRunState;
  removerRun: AgentRunState;
  selectedDetectorReferences: string[];
  setSelectedWorkFile: (file: string | null) => void;
  setSelectedReferenceFile: (file: string | null) => void;
  setActivePreviewFile: (file: string | null) => void;
  setActiveVersionId: (id: string | null) => void;
  setVersions: (versions: any[]) => void;
  setSuggestion: (suggestion: string | null) => void;
  setAiScore: (score: number | null) => void;
  setAutoLoopCount: (count: number) => void;
  setIsAutoLooping: (isLooping: boolean) => void;
  setDetectorRunning: (isRunning: boolean) => void;
  setRemoverRunning: (isRunning: boolean) => void;
  setDetectorMessages: (messages: Message[] | ((messages: Message[]) => Message[])) => void;
  setRemoverMessages: (messages: Message[] | ((messages: Message[]) => Message[])) => void;
  setDetectorRun: (run: AgentRunState) => void;
  setRemoverRun: (run: AgentRunState) => void;
  setSelectedDetectorReferences: (references: string[] | ((references: string[]) => string[])) => void;
}

export const useDeAiStore = create<DeAiState>((set) => ({
  selectedWorkFile: null,
  selectedReferenceFile: null,
  activePreviewFile: null,
  activeVersionId: null,
  versions: [],
  suggestion: null,
  aiScore: null,
  autoLoopCount: 0,
  isAutoLooping: false,
  detectorRunning: false,
  removerRunning: false,
  detectorMessages: [],
  removerMessages: [],
  detectorRun: { runId: null, messageId: null },
  removerRun: { runId: null, messageId: null },
  selectedDetectorReferences: [],
  setSelectedWorkFile: (file) => set({ selectedWorkFile: file, selectedReferenceFile: null, activePreviewFile: file, activeVersionId: null, versions: [], suggestion: null, aiScore: null }),
  setSelectedReferenceFile: (file) => set({ selectedWorkFile: null, selectedReferenceFile: file, activePreviewFile: file, activeVersionId: null, versions: [], suggestion: null, aiScore: null }),
  setActivePreviewFile: (file) => set({ activePreviewFile: file }),
  setActiveVersionId: (id) => set({ activeVersionId: id }),
  setVersions: (versions) => set({ versions }),
  setSuggestion: (suggestion) => set({ suggestion }),
  setAiScore: (score) => set({ aiScore: score }),
  setAutoLoopCount: (count) => set({ autoLoopCount: count }),
  setIsAutoLooping: (isAutoLooping) => set({ isAutoLooping }),
  setDetectorRunning: (detectorRunning) => set({ detectorRunning }),
  setRemoverRunning: (removerRunning) => set({ removerRunning }),
  setDetectorMessages: (messages) => set((state) => ({
    detectorMessages: typeof messages === 'function' ? messages(state.detectorMessages) : messages,
  })),
  setRemoverMessages: (messages) => set((state) => ({
    removerMessages: typeof messages === 'function' ? messages(state.removerMessages) : messages,
  })),
  setDetectorRun: (detectorRun) => set({ detectorRun }),
  setRemoverRun: (removerRun) => set({ removerRun }),
  setSelectedDetectorReferences: (references) => set((state) => ({
    selectedDetectorReferences: typeof references === 'function' ? references(state.selectedDetectorReferences) : references,
  })),
}));

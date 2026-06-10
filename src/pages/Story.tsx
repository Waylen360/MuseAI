import React, { useEffect, useRef, useState } from 'react';
import { Button, Tooltip, Dropdown, Tag, Input, message, Modal, Spin, Select, Radio } from 'antd';
import {
  HistoryOutlined,
  ReloadOutlined,
  CompassOutlined,
  StopOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
  UserOutlined,
  FileProtectOutlined,
  ProfileOutlined,
  CommentOutlined,
  ExperimentOutlined,
  BranchesOutlined
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { useNavigate } from 'react-router-dom';
import { listen } from '@tauri-apps/api/event';


import { useSettingsStore } from '../stores/useSettingsStore';
import { usePartnerStore } from '../stores/usePartnerStore';
import { useStoryStore } from '../stores/useStoryStore';
import { usePartnerChatStore } from '../stores/usePartnerChatStore';
import { useBookTravelStore, type BookTravelBeat, type BookTravelScene, type BookTravelTurnSnapshot } from '../stores/useBookTravelStore';
import { Message, AgentSessionSummary, SessionContextCompaction, AgentToolEntry } from '../stores/useAgentStore';
import {
  buildStoryModelMessages,
  compileStorySystemPrompt,
  getStoryAllowedTools,
} from './storyAgent';

interface ChatStreamEvent {
  runId: string;
  eventType: 'start' | 'delta' | 'thinking_delta' | 'thinking_signature' | 'tool_start' | 'tool_output' | 'tool_end' | 'todo_update' | 'context_compacted' | 'done' | 'error';
  delta?: string;
  message?: string;
  toolCallId?: string;
  toolName?: string;
  toolStatus?: string;
  toolArguments?: string;
  contextCompaction?: SessionContextCompaction;
}

const estimateContextUsage = (systemPrompt: string, messages: Message[], draft: string) => {
  const stats = {
    system: Math.max(0, Math.ceil(systemPrompt.length * 1.5)),
    user: Math.max(0, Math.ceil(([draft, ...messages.filter(m => m.role === 'user').map(m => m.content)].join('')).length * 1.5)),
    assistant: Math.max(0, Math.ceil((messages.filter(m => m.role === 'agent').map(m => m.content).join('')).length * 1.5))
  };
  return {
    ...stats,
    total: stats.system + stats.user + stats.assistant,
  };
};


const cleanAndParseJSON = (rawStr: unknown): any => {
  if (typeof rawStr !== 'string') {
    if (rawStr && typeof rawStr === 'object') return rawStr;
    throw new TypeError(`Expected string or object, got ${typeof rawStr}`);
  }
  let cleaned = rawStr.trim();
  if (cleaned.startsWith('`')) {
    const lines = cleaned.split('\n');
    if (lines[0].startsWith('`')) lines.shift();
    if (lines[lines.length - 1]?.trim() === '`') lines.pop();
    cleaned = lines.join('\n').trim();
  }
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  let startIdx = -1;
  let isObject = true;
  if (firstBrace !== -1 && firstBracket !== -1) {
    if (firstBrace < firstBracket) {
      startIdx = firstBrace;
      isObject = true;
    } else {
      startIdx = firstBracket;
      isObject = false;
    }
  } else if (firstBrace !== -1) {
    startIdx = firstBrace;
    isObject = true;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    isObject = false;
  }
  if (startIdx === -1) {
    throw new Error('No JSON object or array found in response');
  }
  let endIdx = cleaned.length;
  if (isObject) {
    let braceCount = 0;
    for (let i = startIdx; i < cleaned.length; i++) {
      if (cleaned[i] === '{') braceCount++;
      if (cleaned[i] === '}') braceCount--;
      if (braceCount === 0) {
        endIdx = i + 1;
        break;
      }
    }
  } else {
    let bracketCount = 0;
    for (let i = startIdx; i < cleaned.length; i++) {
      if (cleaned[i] === '[') bracketCount++;
      if (cleaned[i] === ']') bracketCount--;
      if (bracketCount === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }
  const jsonStr = cleaned.slice(startIdx, endIdx);
  return JSON.parse(jsonStr);
};

const getPlannerSceneGoals = (plannerOutput: unknown): string[] => {
  if (!plannerOutput || typeof plannerOutput !== 'object') return [];
  const rawGoals = (plannerOutput as any).sceneGoals || (plannerOutput as any).scene_goals;
  if (Array.isArray(rawGoals)) {
    const goals: string[] = [];
    for (const goal of rawGoals) {
      const text = String(goal).trim();
      if (text) goals.push(text);
    }
    return goals;
  }
  if (typeof rawGoals === 'string' && rawGoals.trim()) {
    return [rawGoals.trim()];
  }
  return [];
};

const readPlanText = (plan: any, camelKey: string, snakeKey?: string): string => {
  const value = plan?.[camelKey] ?? (snakeKey ? plan?.[snakeKey] : undefined);
  return typeof value === 'string' ? value.trim() : '';
};

const readPlanStringArray = (plan: any, camelKey: string, snakeKey?: string): string[] => {
  const value = plan?.[camelKey] ?? (snakeKey ? plan?.[snakeKey] : undefined);
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    const text = String(item).trim();
    if (text) items.push(text);
  }
  return items;
};

const getPlanStateChanges = (plan: any): Record<string, unknown> => {
  const stateChanges = plan?.stateChanges ?? plan?.state_changes;
  return stateChanges && typeof stateChanges === 'object' && !Array.isArray(stateChanges)
    ? stateChanges
    : {};
};

const buildCurrentStateFromPlan = (
  baseState: unknown,
  plan: any,
  fallbackTime = '',
  fallbackLocation = '',
) => {
  const stateChanges = getPlanStateChanges(plan);
  const { time: stateTime, location: stateLocation, ...restStateChanges } = stateChanges as Record<string, unknown>;
  const base = baseState && typeof baseState === 'object' ? baseState as Record<string, unknown> : {};
  return {
    ...base,
    ...restStateChanges,
    time: readPlanText(plan, 'time') || String(stateTime || fallbackTime || base.time || ''),
    location: readPlanText(plan, 'location') || String(stateLocation || fallbackLocation || base.location || ''),
  };
};

const buildSceneFromPlan = (
  plan: any,
  fallback: {
    title: string;
    summary?: string;
    currentSituation?: string;
    time?: string;
    location?: string;
    index: number;
  },
): BookTravelScene => {
  const stateChanges = getPlanStateChanges(plan);
  return {
    id: readPlanText(plan, 'id') || `scene-${Date.now()}`,
    title: readPlanText(plan, 'title') || fallback.title || `新场景-${fallback.index}`,
    summary: readPlanText(plan, 'summary') || fallback.summary || '',
    currentSituation: readPlanText(plan, 'currentSituation', 'current_situation') || fallback.currentSituation || '',
    time: readPlanText(plan, 'time') || String(stateChanges.time || fallback.time || ''),
    location: readPlanText(plan, 'location') || String(stateChanges.location || fallback.location || ''),
    activeCharacters: readPlanStringArray(plan, 'activeCharacters', 'active_characters').length > 0
      ? readPlanStringArray(plan, 'activeCharacters', 'active_characters')
      : readPlanStringArray(plan, 'allowedCast', 'allowed_cast'),
    beats: [],
  };
};

const extractWriterBeat = (writerOutput: any): BookTravelBeat | null => {
  const rawBeat = writerOutput?.beat;
  if (!rawBeat || typeof rawBeat !== 'object' || !String(rawBeat.content || '').trim()) {
    return null;
  }
  return {
    id: String(rawBeat.id || `beat-${Date.now()}`),
    content: String(rawBeat.content || ''),
  };
};

const appendWriterBeatToCurrentScene = (writerOutput: any): BookTravelBeat => {
  const store = useBookTravelStore.getState();
  const currentScene = store.scenes.find((s) => s.id === store.currentSceneId);
  if (!currentScene) throw new Error('当前场景不存在');
  const newBeat = extractWriterBeat(writerOutput);
  if (!newBeat) throw new Error('场景写手没有返回有效 beat');
  const existingIds = new Set(currentScene.beats.map((b) => b.id));
  const beatId = existingIds.has(newBeat.id) ? `beat-${Date.now()}` : newBeat.id;
  const beat = {
    id: beatId,
    content: newBeat.content,
  };
  store.addBeatToCurrentScene(beat);
  store.setCurrentBeatId(beatId);
  const patch = writerOutput.volatileMemoryPatch || writerOutput.volatile_memory_patch;
  if (patch && typeof patch === 'object') {
    store.updateVolatileMemory(patch);
  }
  return beat;
};

const formatElapsed = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

const extractPartialContent = (jsonStr: string): string | null => {
  const match = jsonStr.match(/"content"\s*:\s*"([^"]*)/);
  return match ? match[1] : null;
};

const savedProgressDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const Story: React.FC = () => {
  const {
    messages, setMessages,
    input, setInput,
    inputMode, setInputMode,
    isStreaming, setIsStreaming,
    selectedWorldBookId,
    selectedCharacterCardIds,
    sessionId,
    sessionTitle, setSessionTitle,
    activeRun, setActiveRun,
    isSessionArchived,
    contextCompaction, setContextCompaction,
    dynamicRoleLoadingEnabled,
    createNewSession,
    setSessions,
  } = useStoryStore();

  const bookTravelStore = useBookTravelStore();
  const navigate = useNavigate();

  // Book-travel stream states
  const [, setIsTransitioningScene] = useState(false);
  const [isBookTravelSubmitting, setIsBookTravelSubmitting] = useState(false);
  const [startProgressPhase, setStartProgressPhase] = useState<'planner' | 'writer' | 'done' | 'error' | 'cancelled'>('done');
  const [plannerOutput, setPlannerOutput] = useState('');
  const [writerOutput, setWriterOutput] = useState('');
  const [startProgressError, setStartProgressError] = useState('');
  const [startElapsedMs, setStartElapsedMs] = useState(0);
  const [startProgressOpen, setStartProgressOpen] = useState(false);
  const startRunIdRef = useRef<string | null>(null);
  const startResolverRef = useRef<{ resolve: (content: string) => void; reject: (error: string) => void } | null>(null);
  const startCancelledRef = useRef(false);

  const buildBookTravelRequest = (
    role: string,
    systemPrompt: string,
    config: {
      temperature?: number;
      maxOutputTokens?: number;
      maxContextTokens?: number;
      thinkingDepth?: string;
    },
    materials: {
      outline: { id: string; title: string; content?: string };
      worldBook: { id: string; title: string; content?: string };
      characterCards: Array<{ id: string; title: string; content?: string }>;
    },
    state: unknown,
    previousValidState: unknown = {},
  ) => ({
    modelInterface: settings.modelInterface,
    baseUrl: settings.llmBaseUrl,
    apiKey: settings.llmApiKey,
    model: settings.llmModel,
    role,
    materials,
    state,
    previousValidState,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    maxContextTokens: config.maxContextTokens,
    thinkingDepth: 'off',
    systemPrompt,
  });

  const runBookTravelStreamTask = async (commandName: string, request: any, extraArgs?: Record<string, unknown>) => {
    return new Promise<string>((resolve, reject) => {
      if (startCancelledRef.current) {
        reject('用户中断');
        return;
      }
      startResolverRef.current = { resolve, reject };
      invoke<{ runId: string }>(commandName, { request, ...extraArgs })
        .then((result) => {
          startRunIdRef.current = result.runId;
        })
        .catch((err) => {
          reject(String(err));
        });
    });
  };

  const handleCancelStart = async () => {
    startCancelledRef.current = true;
    startResolverRef.current?.reject('用户中断');
    if (startRunIdRef.current) {
      try {
        await invoke('stop_book_travel_stream', { runId: startRunIdRef.current });
      } catch (e) {
        console.error('停止穿书流失败:', e);
      }
    }
    setStartProgressPhase('cancelled');
  };


  const { worldBooks, characterCards } = usePartnerStore();
  const { userInfo: partnerChatUserInfo } = usePartnerChatStore();
  const settings = useSettingsStore();

  const chatHistoryRef = useRef<HTMLDivElement>(null);
  const currentThinkingIdRef = useRef<string | null>(null);

  const activeRunRef = useRef(activeRun);
  const messagesRef = useRef(messages);
  const sessionIdRef = useRef(sessionId);
  const sessionTitleRef = useRef(sessionTitle);
  const isSessionArchivedRef = useRef(isSessionArchived);
  const selectedCharacterCardIdsRef = useRef(selectedCharacterCardIds);
  const contextCompactionRef = useRef<SessionContextCompaction | null>(contextCompaction);


  useEffect(() => { activeRunRef.current = activeRun; }, [activeRun]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { sessionTitleRef.current = sessionTitle; }, [sessionTitle]);
  useEffect(() => { isSessionArchivedRef.current = isSessionArchived; }, [isSessionArchived]);
  useEffect(() => { selectedCharacterCardIdsRef.current = selectedCharacterCardIds; }, [selectedCharacterCardIds]);
  useEffect(() => { contextCompactionRef.current = contextCompaction; }, [contextCompaction]);

  useEffect(() => {
    void refreshSessions();
  }, []);

  // Listen to stream events from tauri backend
  useEffect(() => {
    let isMounted = true;
    let unlistenFn: (() => void) | null = null;

    listen<ChatStreamEvent>('agent-chat-stream', (event) => {
      if (!isMounted) return;
      const activeRun = activeRunRef.current;
      const payload = event.payload;

      if (!activeRun.runId || payload.runId !== activeRun.runId || !activeRun.messageId) {
        return;
      }

      if (payload.eventType === 'delta' && payload.delta) {
        currentThinkingIdRef.current = null;
        setMessages((prev) => prev.map((msg) => (
          msg.id === activeRun.messageId
            ? { ...msg, content: msg.content + payload.delta }
            : msg
        )));
        return;
      }

      if (payload.eventType === 'thinking_delta' && payload.delta) {
        setMessages((prev) => prev.map((msg) => {
          if (msg.id !== activeRun.messageId) return msg;
          let newContent = msg.content;
          const newThinkingBlocks = [...(msg.thinkingBlocks ?? [])];

          if (!currentThinkingIdRef.current) {
            currentThinkingIdRef.current = `thinking-${Date.now()}`;
            newContent += `\n\n[[THINKING:${currentThinkingIdRef.current}]]\n\n`;
            newThinkingBlocks.push({ id: currentThinkingIdRef.current, content: payload.delta! });
          } else {
            const blockIndex = newThinkingBlocks.findIndex(b => b.id === currentThinkingIdRef.current);
            if (blockIndex >= 0) {
              newThinkingBlocks[blockIndex] = {
                ...newThinkingBlocks[blockIndex],
                content: newThinkingBlocks[blockIndex].content + payload.delta!
              };
            }
          }

          return {
            ...msg,
            content: newContent,
            thinkingBlocks: newThinkingBlocks,
            thinking: `${msg.thinking ?? ''}${payload.delta}`
          };
        }));
        return;
      }

      if (payload.eventType === 'thinking_signature' && payload.delta) {
        setMessages((prev) => prev.map((msg) => {
          if (msg.id !== activeRun.messageId) return msg;
          const newThinkingBlocks = [...(msg.thinkingBlocks ?? [])];
          if (newThinkingBlocks.length > 0) {
            newThinkingBlocks[newThinkingBlocks.length - 1] = {
              ...newThinkingBlocks[newThinkingBlocks.length - 1],
              signature: payload.delta
            };
          }
          return { ...msg, thinkingBlocks: newThinkingBlocks };
        }));
        return;
      }

      if (payload.eventType === 'tool_start') {
        currentThinkingIdRef.current = null;
        const toolId = payload.toolCallId || `tool-${Date.now()}`;
        setMessages((prev) => {
          const next = updateMessageTool(prev, activeRun.messageId!, {
            id: toolId,
            name: payload.toolName || '未知工具',
            result: payload.toolName === 'role_play' ? '' : payload.message || '正在执行工具',
            status: payload.toolStatus || 'running',
            arguments: payload.toolArguments || '{}',
          }, 'start');
          return next.map((msg) =>
            msg.id === activeRun.messageId
              ? { ...msg, content: msg.content + `\n\n[[TOOL:${toolId}]]\n\n` }
              : msg
          );
        });
        return;
      }

      if (payload.eventType === 'tool_output' || payload.eventType === 'tool_end') {
        setMessages((prev) => updateMessageTool(prev, activeRun.messageId!, {
          id: payload.toolCallId,
          name: payload.toolName || '未知工具',
          result: payload.message || payload.delta || '',
          status: payload.toolStatus || (payload.eventType === 'tool_end' ? 'success' : 'running'),
        }, payload.eventType === 'tool_end' ? 'end' : 'output'));
        return;
      }

      if (payload.eventType === 'context_compacted' && payload.contextCompaction) {
        contextCompactionRef.current = payload.contextCompaction;
        setContextCompaction(payload.contextCompaction);
        return;
      }

      if (payload.eventType === 'error') {
        currentThinkingIdRef.current = null;
        setMessages((prev) => prev.map((msg) => (
          msg.id === activeRun.messageId
            ? { ...msg, content: payload.message ? `冒险推演失败：${payload.message}` : '冒险推演失败' }
            : msg
        )));
        activeRunRef.current = { runId: null, messageId: null };
        setActiveRun({ runId: null, messageId: null });
        setIsStreaming(false);
        return;
      }

      if (payload.eventType === 'done') {
        currentThinkingIdRef.current = null;
        activeRunRef.current = { runId: null, messageId: null };
        setActiveRun({ runId: null, messageId: null });
        setIsStreaming(false);
        window.setTimeout(() => {
          void saveCurrentSession();
        }, 0);
      }
    }).then((fn) => {
      unlistenFn = fn;
      if (!isMounted) fn();
    });

    return () => {
      isMounted = false;
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // Listen to book-travel stream events
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    listen<any>('book-travel-stream', (event) => {
      if (!active) return;
      const { runId, eventType, delta, message: eventMessage } = event.payload;
      if (startRunIdRef.current && runId !== startRunIdRef.current) return;
      if (eventType === 'delta' && delta) {
        if (startProgressPhase === 'planner') {
          setPlannerOutput((prev) => prev + delta);
        } else if (startProgressPhase === 'writer') {
          setWriterOutput((prev) => prev + delta);
        }
      }
      if (eventType === 'done') {
        startResolverRef.current?.resolve(eventMessage || '');
      }
      if (eventType === 'error') {
        startResolverRef.current?.reject(eventMessage || '未知错误');
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, [startProgressPhase]);

  const scrollToBottomOnce = () => {
    window.requestAnimationFrame(() => {
      if (chatHistoryRef.current) {
        chatHistoryRef.current.scrollTop = chatHistoryRef.current.scrollHeight;
      }
    });
  };

  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottomOnce();
    }
  }, [messages.length]);

  const selectedWorldBook = worldBooks.find(wb => wb.id === selectedWorldBookId) || null;
  const selectedCards = characterCards.filter(cc => selectedCharacterCardIds.includes(cc.id));
  const storyAllowedTools = getStoryAllowedTools(dynamicRoleLoadingEnabled);
  const rolePlayContext = dynamicRoleLoadingEnabled ? {
    chatSystemPrompt: settings.partnerChatPrompt || '',
    worldBookContent: selectedWorldBook?.content || '',
    userInfo: partnerChatUserInfo,
    characterCards: selectedCards.map((card) => ({
      id: card.id,
      name: card.name,
      content: card.content,
    })),
  } : null;

  // Compile final Prompt
  const baseSystemPrompt = dynamicRoleLoadingEnabled
    ? settings.storyDynamicAgentPrompt || ''
    : settings.storyAgentPrompt || '';
  const effectiveSystemPrompt = compileStorySystemPrompt({
    basePrompt: baseSystemPrompt,
    worldBookContent: selectedWorldBook ? selectedWorldBook.content : null,
    characterCards: selectedCards.map((card) => ({ name: card.name, content: card.content })),
    userInfo: partnerChatUserInfo,
    dynamicRoleLoadingEnabled,
  });
  const storyAgentConfigId = dynamicRoleLoadingEnabled ? 'storyDynamicAgent' : 'storyAgent';
  const storyAgentConfig = settings.agentConfigs?.[storyAgentConfigId] || {
    temperature: 0.3,
    maxOutputTokens: 32000,
    maxContextTokens: 200000,
    thinkingDepth: 'off',
  };
  const isActiveBookTravelScene = bookTravelStore.scenes.length > 0;
  const isBookTravelBusy = isActiveBookTravelScene && (
    isBookTravelSubmitting ||
    startProgressPhase === 'planner' ||
    startProgressPhase === 'writer'
  );
  const currentBookTravelScene = bookTravelStore.scenes.find((s) => s.id === bookTravelStore.currentSceneId);
  const currentBookTravelSceneTitle = currentBookTravelScene?.title?.trim();

  const restartBookTravelAdventure = () => {
    startCancelledRef.current = true;
    if (startRunIdRef.current) {
      void invoke('stop_book_travel_stream', { runId: startRunIdRef.current }).catch((error) => {
        console.error('停止穿书流失败:', error);
      });
    }
    createNewSession();
    useBookTravelStore.getState().resetSession();
    setIsTransitioningScene(false);
    setIsBookTravelSubmitting(false);
    setStartProgressOpen(false);
    setStartProgressPhase('done');
    setPlannerOutput('');
    setWriterOutput('');
    setStartProgressError('');
    setStartElapsedMs(0);
    startRunIdRef.current = null;
    startResolverRef.current = null;
  };


  const showBookTravelStatusModal = () => {
    const currentScene = bookTravelStore.scenes.find((s) => s.id === bookTravelStore.currentSceneId);
    const summary = bookTravelStore.summaryMemory;
    const turns = bookTravelStore.turns;
    Modal.info({
      title: '穿书状态',
      width: 680,
      content: (
        <div style={{ lineHeight: 1.8, color: '#33312e', maxHeight: 520, overflowY: 'auto' }}>
          <section style={{ marginBottom: 18 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>当前状态</div>
            {bookTravelStore.userCharacter && (
              <div>
                <strong>扮演身份：</strong>
                {bookTravelStore.userCharacter.name}（{bookTravelStore.userCharacter.identity}）
                <br /><strong>目标：</strong>{bookTravelStore.userCharacter.goal}
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <strong>时间：</strong>{String((bookTravelStore.currentState as any)?.time || currentScene?.time || '未知')}
              <br /><strong>地点：</strong>{String((bookTravelStore.currentState as any)?.location || currentScene?.location || '未知')}
            </div>
            {bookTravelStore.volatileMemory && (
              <div style={{ marginTop: 8 }}>
                {Object.entries(bookTravelStore.volatileMemory).map(([k, v]) => (
                  <div key={k}><strong>{k}：</strong>{String(v)}</div>
                ))}
              </div>
            )}
          </section>

          <section>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>剧情回顾</div>
            {summary ? (
              <div style={{ marginBottom: 12, padding: 12, background: '#faf9f5', borderRadius: 8 }}>
                <strong>剧情摘要：</strong>
                <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{String(summary)}</div>
              </div>
            ) : null}
            {turns.length > 0 ? (
              <div>
                <strong>近期回合：</strong>
                {turns.slice(-5).map((turn, idx) => (
                  <div key={turn.id} style={{ marginTop: 8, padding: 8, background: '#faf9f5', borderRadius: 6 }}>
                    <div style={{ fontSize: 12, color: '#8c8882', marginBottom: 4 }}>回合 {Math.max(1, turns.length - 5 + idx + 1)}</div>
                    <div><strong>你：</strong>{turn.userInput}</div>
                    <div style={{ marginTop: 4 }}><strong>剧情：</strong>{turn.narrativeOutput}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: '#8c8882' }}>暂无剧情记录</div>
            )}
          </section>
        </div>
      ),
    });
  };

  const runChangeSceneWriterForPlan = async ({
    userInput,
    plan,
    plannedScene,
    currentState,
    turnId,
    materials,
    stableMemory,
    volatileMemory,
    assembledWorldModel,
    recentScenes,
    recentTurns,
  }: {
    userInput: string;
    plan: any;
    plannedScene: BookTravelScene;
    currentState: unknown;
    turnId?: string;
    materials: any;
    stableMemory: unknown;
    volatileMemory: unknown;
    assembledWorldModel: unknown;
    recentScenes: BookTravelScene[];
    recentTurns: BookTravelTurnSnapshot[];
  }) => {
    const writerInstructions = readPlanText(plan, 'writerInstructions', 'writer_instructions') || userInput;
    const writerConfig = settings.agentConfigs?.bookTravelSceneWriter || {};
    const writerState = {
      stableMemory,
      volatileMemory,
      assembledWorldModel,
      currentState,
      summaryMemory: useBookTravelStore.getState().summaryMemory || '',
      recentScenes,
      recentTurns,
      plannedScene,
      writerInstructions,
    };
    const writerRequest = buildBookTravelRequest('scene-writer', settings.bookTravelSceneWriterPrompt, writerConfig, materials, writerState);
    const writerOutputStr = await runBookTravelStreamTask(
      'start_write_book_travel_change_scene_stream',
      writerRequest,
      { userInput: writerInstructions, allowedSpeakers: plannedScene.activeCharacters || [] },
    );
    const writerOutput = cleanAndParseJSON(writerOutputStr);
    const newBeat = appendWriterBeatToCurrentScene(writerOutput);
    const store = useBookTravelStore.getState();
    const completedScene = store.scenes.find((scene) => scene.id === plannedScene.id) || {
      ...plannedScene,
      beats: [newBeat],
    };
    const turnPatch = {
      classification: 'change-scene' as const,
      status: 'done' as const,
      failedStage: undefined,
      plannerOutput: plan,
      narrativeOutput: newBeat.content,
      stateSnapshot: currentState,
      createdSceneId: plannedScene.id,
      createdBeatIds: [newBeat.id],
    };
    const newTurn = { id: turnId || `turn-${Date.now()}`, userInput, ...turnPatch };
    if (turnId) {
      store.updateTurn(turnId, turnPatch);
    } else {
      store.appendTurn(newTurn);
    }

    const latestState = useBookTravelStore.getState();
    const recentTurnsWithoutCurrent = latestState.turns.filter((turn) => turn.id !== newTurn.id);
    const endingStatus = readPlanText(plan, 'endingStatus', 'ending_status');
    if (endingStatus && endingStatus !== 'none' && endingStatus !== 'active') {
      const judgeConfig = settings.agentConfigs?.bookTravelEndingJudge || {};
      const judgeState = { stableMemory, volatileMemory, assembledWorldModel, currentState, summaryMemory: latestState.summaryMemory || '', recentScenes: [...recentScenes.slice(-3), completedScene], recentTurns: [...recentTurnsWithoutCurrent.slice(-5), newTurn] };
      const judgeRequest = buildBookTravelRequest('ending-judge', settings.bookTravelEndingJudgePrompt, judgeConfig, materials, judgeState);
      const endingJsonStr = await invoke<string>('judge_book_travel_ending', { request: judgeRequest });
      const ending = cleanAndParseJSON(endingJsonStr);
      useBookTravelStore.getState().finishSession(ending);
      message.success('已达成穿书结局！');
    } else {
      const keeperConfig = settings.agentConfigs?.bookTravelMemoryKeeper || {};
      const keeperState = { stableMemory, volatileMemory, assembledWorldModel, currentState, summaryMemory: latestState.summaryMemory || '', recentScenes: [...recentScenes.slice(-3), completedScene], recentTurns: [...recentTurnsWithoutCurrent.slice(-5), newTurn] };
      const keeperRequest = buildBookTravelRequest('memory-keeper', settings.bookTravelMemoryKeeperPrompt, keeperConfig, materials, keeperState);
      invoke<string>('summarize_book_travel_memory', { request: keeperRequest }).then((resStr) => {
        try { const res = cleanAndParseJSON(resStr); if (res.summary) useBookTravelStore.getState().updateSummaryMemory(res.summary); }
        catch (e) { console.error('Failed to parse memory keeper summary:', e); }
      }).catch((err) => { console.error('Failed to update memory keeper:', err); });
    }

    return newTurn;
  };

  const handleInsertBeatStream = async (userInput: string, turnId?: string) => {
    setIsTransitioningScene(true);
    setStartProgressPhase('writer');
    setWriterOutput('');
    setStartProgressError('');
    setStartElapsedMs(0);
    startCancelledRef.current = false;
    let elapsedInterval: ReturnType<typeof setInterval> | null = null;
    try {
      elapsedInterval = setInterval(() => setStartElapsedMs((p) => p + 100), 100);
      const { selectedOutline, selectedWorldBook, selectedCharacterCards, stableMemory, volatileMemory, assembledWorldModel, scenes, turns } = useBookTravelStore.getState();
      if (!selectedOutline || !selectedWorldBook) throw new Error('素材缺失');
      const materials = {
        outline: { id: selectedOutline.id, title: selectedOutline.title, content: selectedOutline.content },
        worldBook: { id: selectedWorldBook.id, title: selectedWorldBook.title, content: selectedWorldBook.content },
        characterCards: selectedCharacterCards.map((cc: any) => ({ id: cc.id, title: cc.title, content: cc.content })),
      };
      const writerConfig = settings.agentConfigs?.bookTravelSceneWriter || {};
      const writerState = { stableMemory, volatileMemory, assembledWorldModel, currentState: bookTravelStore.currentState, summaryMemory: bookTravelStore.summaryMemory || '', recentScenes: scenes.slice(-3), recentTurns: turns.slice(-5), writerInstructions: userInput };
      const writerRequest = buildBookTravelRequest('scene-writer', settings.bookTravelSceneWriterPrompt, writerConfig, materials, writerState);
      const currentScene = scenes.find((s) => s.id === bookTravelStore.currentSceneId);
      const allowedSpeakers = currentScene?.activeCharacters || [];
      const sceneJsonStr = await runBookTravelStreamTask('start_write_book_travel_insert_beat_stream', writerRequest, { userInput, allowedSpeakers });
      const writerOutput = cleanAndParseJSON(sceneJsonStr);
      const newBeat = appendWriterBeatToCurrentScene(writerOutput);
      const turnPatch = {
        classification: 'insert-beat' as const,
        status: 'done' as const,
        failedStage: undefined,
        narrativeOutput: newBeat?.content || '',
        stateSnapshot: useBookTravelStore.getState().currentState,
        createdBeatIds: [newBeat?.id || ''].filter(Boolean),
      };
      if (turnId) {
        useBookTravelStore.getState().updateTurn(turnId, turnPatch);
      } else {
        bookTravelStore.appendTurn({ id: `turn-${Date.now()}`, userInput, ...turnPatch });
      }
      setStartProgressPhase('done');
    } catch (err: any) {
      if (startCancelledRef.current) {
        message.info('已中断');
        if (turnId) {
          useBookTravelStore.getState().updateTurn(turnId, {
            classification: 'insert-beat',
            status: 'error',
            failedStage: undefined,
            narrativeOutput: '已中断生成',
          });
        }
        setStartProgressPhase('cancelled');
      }
      else {
        const errorMsg = String(err);
        message.error(`生成失败：${errorMsg}`);
        if (turnId) {
          useBookTravelStore.getState().updateTurn(turnId, {
            classification: 'insert-beat',
            status: 'error',
            failedStage: 'writing',
            narrativeOutput: `写手生成失败：${errorMsg}`,
          });
        }
        setStartProgressError(errorMsg);
        setStartProgressPhase('error');
      }
    } finally {
      if (elapsedInterval) clearInterval(elapsedInterval);
      setIsTransitioningScene(false);
      startRunIdRef.current = null;
      startResolverRef.current = null;
    }
  };

  const handleChangeSceneStream = async (userInput: string, turnId?: string) => {
    setIsTransitioningScene(true);
    setStartProgressOpen(true);
    setStartProgressPhase('planner');
    setPlannerOutput('');
    setStartProgressError('');
    setStartElapsedMs(0);
    startCancelledRef.current = false;
    let elapsedInterval: ReturnType<typeof setInterval> | null = null;
    let failedStage: 'planning' | 'writing' = 'planning';
    let plan: any = null;
    let plannedScene: BookTravelScene | null = null;
    let newCurrentState: unknown = null;
    try {
      elapsedInterval = setInterval(() => setStartElapsedMs((p) => p + 100), 100);
      const { selectedOutline, selectedWorldBook, selectedCharacterCards, stableMemory, volatileMemory, assembledWorldModel, scenes, turns, userCharacter } = useBookTravelStore.getState();
      if (!selectedOutline || !selectedWorldBook) throw new Error('素材缺失');
      const materials = {
        outline: { id: selectedOutline.id, title: selectedOutline.title, content: selectedOutline.content },
        worldBook: { id: selectedWorldBook.id, title: selectedWorldBook.title, content: selectedWorldBook.content },
        characterCards: selectedCharacterCards.map((cc: any) => ({ id: cc.id, title: cc.title, content: cc.content })),
      };
      const plannerConfig = settings.agentConfigs?.bookTravelScenePlanner || {};
      const plannerState = { stableMemory, volatileMemory, assembledWorldModel, currentState: bookTravelStore.currentState, summaryMemory: bookTravelStore.summaryMemory || '', recentScenes: scenes.slice(-3), recentTurns: turns.slice(-5), userCharacter };
      const plannerRequest = buildBookTravelRequest('scene-planner', settings.bookTravelPlotPlannerPrompt, plannerConfig, materials, plannerState);
      const plannerPlanStr = await runBookTravelStreamTask('start_plan_book_travel_scene_stream', plannerRequest, { userInput });
      plan = cleanAndParseJSON(plannerPlanStr);
      newCurrentState = buildCurrentStateFromPlan(useBookTravelStore.getState().currentState, plan);
      plannedScene = buildSceneFromPlan(plan, {
        title: `新场景-${scenes.length + 1}`,
        currentSituation: readPlanText(plan, 'summary'),
        time: (newCurrentState as any).time || '',
        location: (newCurrentState as any).location || '',
        index: scenes.length + 1,
      });
      const store = useBookTravelStore.getState();
      store.setCurrentState(newCurrentState);
      store.addScene(plannedScene);
      if (turnId) {
        store.updateTurn(turnId, {
          classification: 'change-scene',
          status: 'writing',
          failedStage: undefined,
          plannerOutput: plan,
          stateSnapshot: newCurrentState,
          createdSceneId: plannedScene.id,
        });
      }
      scrollToBottomOnce();
      failedStage = 'writing';
      setStartProgressOpen(false);
      setStartProgressPhase('writer');
      setWriterOutput('');
      await runChangeSceneWriterForPlan({
        userInput,
        plan,
        plannedScene,
        currentState: newCurrentState,
        turnId,
        materials,
        stableMemory,
        volatileMemory,
        assembledWorldModel,
        recentScenes: scenes.slice(-3),
        recentTurns: turns.slice(-5),
      });
      setStartProgressPhase('done');
      message.success('已切换至新场景！');
    } catch (err: any) {
      if (startCancelledRef.current) {
        message.info('已中断');
        if (turnId) {
          useBookTravelStore.getState().updateTurn(turnId, {
            classification: 'change-scene',
            status: 'error',
            failedStage: undefined,
            narrativeOutput: '已中断生成',
          });
        }
        setStartProgressPhase('cancelled');
      }
      else {
        const errorMsg = String(err);
        message.error(`切换场景失败：${errorMsg}`);
        if (turnId) {
          useBookTravelStore.getState().updateTurn(turnId, {
            classification: 'change-scene',
            status: 'error',
            failedStage,
            plannerOutput: plan || undefined,
            stateSnapshot: newCurrentState || useBookTravelStore.getState().currentState,
            createdSceneId: plannedScene?.id,
            narrativeOutput: failedStage === 'writing'
              ? `写手生成失败：${errorMsg}`
              : `切换场景失败：${errorMsg}`,
          });
        }
        setStartProgressError(errorMsg);
        setStartProgressPhase('error');
      }
    } finally {
      if (elapsedInterval) clearInterval(elapsedInterval);
      setIsTransitioningScene(false);
      startRunIdRef.current = null;
      startResolverRef.current = null;
    }
  };

  const retryBookTravelWriter = async (turn: BookTravelTurnSnapshot) => {
    if (isBookTravelBusy || turn.failedStage !== 'writing') return;
    setIsBookTravelSubmitting(true);
    useBookTravelStore.getState().updateTurn(turn.id, {
      status: 'writing',
      failedStage: undefined,
      narrativeOutput: '',
    });

    if (turn.classification === 'insert-beat') {
      try {
        await handleInsertBeatStream(turn.userInput, turn.id);
      } finally {
        setIsBookTravelSubmitting(false);
      }
      return;
    }

    setIsTransitioningScene(true);
    setStartProgressOpen(false);
    setStartProgressPhase('writer');
    setWriterOutput('');
    setStartProgressError('');
    setStartElapsedMs(0);
    startCancelledRef.current = false;
    let elapsedInterval: ReturnType<typeof setInterval> | null = null;
    try {
      elapsedInterval = setInterval(() => setStartElapsedMs((p) => p + 100), 100);
      const store = useBookTravelStore.getState();
      const { selectedOutline, selectedWorldBook, selectedCharacterCards, stableMemory, volatileMemory, assembledWorldModel } = store;
      if (!selectedOutline || !selectedWorldBook) throw new Error('素材缺失');
      if (!turn.plannerOutput || !turn.createdSceneId) throw new Error('缺少可重试的场景规划');
      const plannedScene = store.scenes.find((scene) => scene.id === turn.createdSceneId);
      if (!plannedScene) throw new Error('找不到规划出的场景');
      const materials = {
        outline: { id: selectedOutline.id, title: selectedOutline.title, content: selectedOutline.content },
        worldBook: { id: selectedWorldBook.id, title: selectedWorldBook.title, content: selectedWorldBook.content },
        characterCards: selectedCharacterCards.map((cc: any) => ({ id: cc.id, title: cc.title, content: cc.content })),
      };
      await runChangeSceneWriterForPlan({
        userInput: turn.userInput,
        plan: turn.plannerOutput,
        plannedScene,
        currentState: turn.stateSnapshot || store.currentState,
        turnId: turn.id,
        materials,
        stableMemory,
        volatileMemory,
        assembledWorldModel,
        recentScenes: store.scenes.slice(-3),
        recentTurns: store.turns.slice(-5),
      });
      setStartProgressPhase('done');
      message.success('场景写手已重试完成');
    } catch (err: any) {
      if (startCancelledRef.current) {
        message.info('已中断');
        useBookTravelStore.getState().updateTurn(turn.id, {
          status: 'error',
          failedStage: undefined,
          narrativeOutput: '已中断生成',
        });
        setStartProgressPhase('cancelled');
      } else {
        const errorMsg = String(err);
        message.error(`写手生成失败：${errorMsg}`);
        useBookTravelStore.getState().updateTurn(turn.id, {
          status: 'error',
          failedStage: 'writing',
          narrativeOutput: `写手生成失败：${errorMsg}`,
        });
        setStartProgressError(errorMsg);
        setStartProgressPhase('error');
      }
    } finally {
      if (elapsedInterval) clearInterval(elapsedInterval);
      setIsTransitioningScene(false);
      setIsBookTravelSubmitting(false);
      startRunIdRef.current = null;
      startResolverRef.current = null;
    }
  };

  const startBookTravelAdventure = async () => {
    const { selectedEntryPointId, userCharacter, assembledWorldModel, stableMemory, volatileMemory, selectedOutline, selectedWorldBook, selectedCharacterCards } = bookTravelStore;
    if (!selectedEntryPointId) {
      message.warning('请选择一个入场点');
      return;
    }
    if (!userCharacter || !userCharacter.name.trim()) {
      message.warning('请选择或填写一个扮演身份');
      return;
    }
    if (!selectedOutline || !selectedWorldBook) {
      message.warning('素材缺失，请重新装配素材');
      return;
    }

    setIsTransitioningScene(true);
    setStartProgressOpen(true);
    setStartProgressPhase('planner');
    setPlannerOutput('');
    setStartProgressError('');
    setStartElapsedMs(0);
    startCancelledRef.current = false;

    let elapsedInterval: ReturnType<typeof setInterval> | null = null;
    let openingTurnId: string | null = null;
    let plannerCompleted = false;
    try {
      elapsedInterval = setInterval(() => setStartElapsedMs((prev) => prev + 100), 100);

      const entryPoint = bookTravelStore.entryPoints.find(ep => ep.id === selectedEntryPointId);
      if (!entryPoint) throw new Error('选中的入场点不存在');

      const materials = {
        outline: { id: selectedOutline.id, title: selectedOutline.title, content: selectedOutline.content },
        worldBook: { id: selectedWorldBook.id, title: selectedWorldBook.title, content: selectedWorldBook.content },
        characterCards: selectedCharacterCards.map(cc => ({ id: cc.id, title: cc.title, content: cc.content })),
      };

      const plannerConfig = settings.agentConfigs?.bookTravelScenePlanner || {};
      const plannerState = { stableMemory, volatileMemory, assembledWorldModel, currentState: null, summaryMemory: '', recentScenes: [], recentTurns: [], userCharacter, selectedEntryPointId };
      const plannerRequest = buildBookTravelRequest('scene-planner', settings.bookTravelPlotPlannerPrompt, plannerConfig, materials, plannerState);
      const plannerInput = `确认以入场点 [${entryPoint.title}] 入场，扮演新身份 [${userCharacter.name}]（${userCharacter.identity}）。\n详细局势：${entryPoint.situation || entryPoint.summary || ''}\n初始目标：${entryPoint.initialGoal || ''}\n面临风险：${entryPoint.risk || ''}`;
      const plannerPlanStr = await runBookTravelStreamTask('start_plan_book_travel_scene_stream', plannerRequest, { userInput: plannerInput });

      const plan = cleanAndParseJSON(plannerPlanStr);
      const newCurrentState = buildCurrentStateFromPlan(
        plannerState.currentState,
        plan,
        entryPoint.timeAndLocation || '',
        entryPoint.timeAndLocation || '',
      );
      const plannedScene = buildSceneFromPlan(plan, {
        title: entryPoint.title,
        summary: entryPoint.situation || entryPoint.summary,
        currentSituation: entryPoint.situation,
        time: (newCurrentState as any).time || entryPoint.timeAndLocation,
        location: (newCurrentState as any).location || entryPoint.timeAndLocation,
        index: 1,
      });
      const store = useBookTravelStore.getState();
      store.setCurrentState(newCurrentState);
      store.addScene(plannedScene);
      openingTurnId = `turn-${Date.now()}`;
      plannerCompleted = true;
      store.appendTurn({
        id: openingTurnId,
        userInput: plannerInput,
        classification: 'change-scene' as const,
        status: 'writing' as const,
        plannerOutput: plan,
        narrativeOutput: '',
        stateSnapshot: newCurrentState,
        createdSceneId: plannedScene.id,
        createdBeatIds: [],
      });
      scrollToBottomOnce();

      setStartProgressOpen(false);
      setStartProgressPhase('writer');
      setWriterOutput('');
      const writerConfig = settings.agentConfigs?.bookTravelSceneWriter || {};
      const writerInstructions = readPlanText(plan, 'writerInstructions', 'writer_instructions') || plannerInput;
      const writerState = { stableMemory, volatileMemory, assembledWorldModel, currentState: newCurrentState, summaryMemory: '', recentScenes: [], recentTurns: [], plannedScene, writerInstructions };
      const writerRequest = buildBookTravelRequest('scene-writer', settings.bookTravelSceneWriterPrompt, writerConfig, materials, writerState);
      const sceneJsonStr = await runBookTravelStreamTask('start_write_book_travel_change_scene_stream', writerRequest, { userInput: writerInstructions, allowedSpeakers: plannedScene.activeCharacters || [] });

      const writerOutput = cleanAndParseJSON(sceneJsonStr);
      const firstBeat = appendWriterBeatToCurrentScene(writerOutput);
      useBookTravelStore.getState().updateTurn(openingTurnId, {
        status: 'done' as const,
        failedStage: undefined,
        plannerOutput: plan,
        narrativeOutput: firstBeat?.content || '',
        stateSnapshot: newCurrentState,
        createdSceneId: plannedScene.id,
        createdBeatIds: [firstBeat?.id || ''],
      });
      const autoTitle = `${selectedOutline.title}-${entryPoint.title}`;
      setSessionTitle(autoTitle);
      sessionTitleRef.current = autoTitle;
      setStartProgressPhase('done');
      message.success('穿书冒险已开始！');
    } catch (err: any) {
      if (startCancelledRef.current) {
        message.info('已中断穿书开始');
        if (openingTurnId) {
          useBookTravelStore.getState().updateTurn(openingTurnId, {
            status: 'error',
            failedStage: undefined,
            narrativeOutput: '已中断生成',
          });
        }
        setStartProgressPhase('cancelled');
      } else {
        const errorMsg = String(err);
        if (openingTurnId) {
          useBookTravelStore.getState().updateTurn(openingTurnId, {
            status: 'error',
            failedStage: 'writing',
            narrativeOutput: `写手生成失败：${errorMsg}`,
          });
        }
        message.error(plannerCompleted ? `写手生成失败：${errorMsg}` : `开始穿书冒险失败：${errorMsg}`);
        setStartProgressError(errorMsg);
        setStartProgressPhase('error');
        console.error(err);
      }
    } finally {
      if (elapsedInterval) clearInterval(elapsedInterval);
      setIsTransitioningScene(false);
      startRunIdRef.current = null;
      startResolverRef.current = null;
    }
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming || isBookTravelBusy) return;

    if (isActiveBookTravelScene) {
      setIsBookTravelSubmitting(true);
      setInput('');
      const pendingTurnId = `turn-${Date.now()}`;
      let pendingTurnCreated = false;
      try {
        const { selectedOutline, selectedWorldBook, selectedCharacterCards } = useBookTravelStore.getState();
        if (!selectedOutline || !selectedWorldBook) {
          message.error('素材缺失，请重新装配素材');
          return;
        }
        useBookTravelStore.getState().appendTurn({
          id: pendingTurnId,
          userInput: trimmed,
          status: 'classifying',
          narrativeOutput: '',
          stateSnapshot: useBookTravelStore.getState().currentState,
          createdBeatIds: [],
        });
        pendingTurnCreated = true;
        scrollToBottomOnce();
        const materials = {
          outline: { id: selectedOutline.id, title: selectedOutline.title, content: selectedOutline.content },
          worldBook: { id: selectedWorldBook.id, title: selectedWorldBook.title, content: selectedWorldBook.content },
          characterCards: selectedCharacterCards.map((cc: any) => ({ id: cc.id, title: cc.title, content: cc.content })),
        };
        const classifierConfig = settings.agentConfigs?.bookTravelInputClassifier || {};
        const latestBookTravelState = useBookTravelStore.getState();
        const classifierState = {
          stableMemory: latestBookTravelState.stableMemory,
          volatileMemory: latestBookTravelState.volatileMemory,
          assembledWorldModel: latestBookTravelState.assembledWorldModel,
          currentState: latestBookTravelState.currentState,
          summaryMemory: latestBookTravelState.summaryMemory || '',
          recentScenes: latestBookTravelState.scenes.slice(-3),
          recentTurns: latestBookTravelState.turns.slice(-5),
          userCharacter: latestBookTravelState.userCharacter,
        };
        const classifierRequest = buildBookTravelRequest(
          'input-classifier',
          '你是一个穿书行动分类器。根据用户输入判断其会影响当前场景内的局部互动，还是需要切换到新场景。\n- insert-beat: 在当前场景中继续互动，例如对话、观察、小动作、短暂试探。\n- change-scene: 切换场景，例如离开地点、跳过时间、做出重大决定、触发新事件。\n只输出严格 JSON，classification 只能是 insert-beat 或 change-scene，不要解释。',
          { ...classifierConfig, temperature: 0 },
          materials,
          classifierState,
        );
        const classificationResult = await invoke<{ classification: 'insert-beat' | 'change-scene' }>('classify_book_travel_input', {
          request: classifierRequest,
          userInput: trimmed,
        });
        switch (classificationResult.classification) {
          case 'insert-beat':
            useBookTravelStore.getState().updateTurn(pendingTurnId, { classification: 'insert-beat', status: 'writing', failedStage: undefined });
            await handleInsertBeatStream(trimmed, pendingTurnId);
            break;
          case 'change-scene':
            useBookTravelStore.getState().updateTurn(pendingTurnId, { classification: 'change-scene', status: 'writing', failedStage: undefined });
            await handleChangeSceneStream(trimmed, pendingTurnId);
            break;
          default: message.warning('无法识别输入意图，请重新输入');
        }
      } catch (err) {
        if (pendingTurnCreated) {
          useBookTravelStore.getState().updateTurn(pendingTurnId, {
            status: 'error',
            failedStage: 'classifying',
            narrativeOutput: `处理失败：${String(err)}`,
          });
        }
        message.error(`处理失败：${String(err)}`);
      } finally {
        setIsBookTravelSubmitting(false);
      }
      return;
    }

    let formattedText = trimmed;
    if (inputMode === 'speech') {
      formattedText = `我："${trimmed}"`;
    } else if (inputMode === 'behavior') {
      formattedText = `（我 ${trimmed}）`;
    } else if (inputMode === 'plot') {
      formattedText = `[剧情推进] ${trimmed}`;
    }
    const userMessage: Message = { id: `msg-${Date.now()}`, role: 'user', content: formattedText, tools: [] };
    const agentMessageId = `msg-${Date.now() + 1}`;
    const pendingAgentMessage: Message = { id: agentMessageId, role: 'agent', content: '', tools: [] };
    const nextMessages = [...messages, userMessage, pendingAgentMessage];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setInput('');
    setIsStreaming(true);
    scrollToBottomOnce();
    try {
      const modelMessages = buildStoryModelMessages(nextMessages.slice(0, -1));
      const runId = await invoke<string>('start_chat_completion_stream', {
        request: {
          modelInterface: settings.modelInterface, baseUrl: settings.llmBaseUrl, apiKey: settings.llmApiKey,
          model: settings.llmModel, temperature: storyAgentConfig.temperature ?? 0.3,
          maxOutputTokens: storyAgentConfig.maxOutputTokens ?? 32000,
          maxContextTokens: storyAgentConfig.maxContextTokens ?? 200000,
          thinkingDepth: storyAgentConfig.thinkingDepth ?? 'off',
          systemPrompt: effectiveSystemPrompt, workspacePath: null, messages: modelMessages,
          contextCompaction: contextCompactionRef.current, selectedReferenceFiles: [],
          allowedTools: storyAllowedTools, rolePlayContext,
        }
      });
      activeRunRef.current = { runId, messageId: agentMessageId };
      setActiveRun({ runId, messageId: agentMessageId });
    } catch (err) {
      activeRunRef.current = { runId: null, messageId: null };
      setActiveRun({ runId: null, messageId: null });
      setIsStreaming(false);
      setMessages((prev) => prev.map((msg) => msg.id === agentMessageId ? { ...msg, content: `请求冒险发生故障：${String(err)}` } : msg));
    }
  };

  const handleStop = async () => {
    if (activeRunRef.current.runId) {
      try {
        await invoke('stop_chat_stream', { runId: activeRunRef.current.runId });
      } catch (err) {
        console.error('停止冒险失败:', err);
      }
    }
    setIsStreaming(false);
  };

  const refreshSessions = async () => {
    try {
      const summaries = await invoke<AgentSessionSummary[]>('list_agent_sessions', { prefix: 'story-session-' });
      setSessions(summaries);
    } catch (err) {
      console.error('读取故事会话失败:', err);
    }
  };

  const saveCurrentSession = async () => {
    const userMessages = messagesRef.current.filter(m => m.role === 'user');
    if (userMessages.length === 0) return;

    try {
      await invoke<AgentSessionSummary>('save_agent_session', {
        session: {
          id: sessionIdRef.current,
          title: sessionTitleRef.current,
          savedAt: Date.now(),
          messages: messagesRef.current,
          selectedReferenceFiles: [],
          selectedOutlineFile: null,
          todos: [],
          contextCompaction: contextCompactionRef.current,
          isArchived: isSessionArchivedRef.current,
          selectedWorldBookId,
          dynamicRoleLoadingEnabled,
          characterCardIds: selectedCharacterCardIdsRef.current
        }
      });
      await refreshSessions();
    } catch (err) {
      console.error('保存故事会话失败:', err);
    }
  };

  // Context Stats
  const contextStats = estimateContextUsage(effectiveSystemPrompt, messages, input);
  const maxContext = storyAgentConfig.maxContextTokens ?? 200000;
  const contextPercent = maxContext > 0
    ? Math.min(100, Math.round((contextStats.total / maxContext) * 100))
    : 0;

  const contextTooltip = (
    <div className="agent-context-popover">
      <div className="agent-context-popover__header">
        <strong>冒险上下文详情</strong>
      </div>
      <div className="agent-context-popover__row">
        <span className="agent-context-popover__label">世界书：</span>
        <span className="agent-context-popover__value">{selectedWorldBook?.name || '未绑定'}</span>
      </div>
      <div className="agent-context-popover__row">
        <span className="agent-context-popover__label">活跃角色：</span>
        <span className="agent-context-popover__value">{selectedCards.map(c => c.name).join(', ') || '未绑定'}</span>
      </div>
      <div className="agent-context-popover__divider" />
      <div className="agent-context-popover__row">
        <span className="agent-context-popover__label">总估 Token：</span>
        <span className="agent-context-popover__value agent-context-popover__value--highlight">{contextStats.total} / {maxContext}</span>
      </div>
    </div>
  );

  const hasMessages = messages.length > 0;

  return (
    <div className="agent-chat" style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#faf9f5' }}>

      {/* Book Travel Planner Progress Modal */}
      <Modal
        open={startProgressOpen}
        onCancel={() => {
          if (startProgressPhase === 'error' || startProgressPhase === 'cancelled') {
            setStartProgressOpen(false);
            setStartProgressPhase('done');
          }
        }}
        closable={startProgressPhase === 'error' || startProgressPhase === 'cancelled'}
        maskClosable={startProgressPhase === 'error' || startProgressPhase === 'cancelled'}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#33312e', fontSize: '18px', fontWeight: 600 }}>
            <CompassOutlined style={{ color: '#d97757' }} />
            <span>穿书任务进展</span>
          </div>
        }
        width={680}
        styles={{ body: { padding: '16px 24px' } }}
        footer={
          startProgressPhase === 'planner' ? (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button size="small" onClick={handleCancelStart}>中断</Button>
            </div>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button onClick={() => { setStartProgressOpen(false); setStartProgressPhase('done'); }}>关闭</Button>
            </div>
          )
        }
      >
        <div style={{ height: 400, overflowY: 'auto' }}>
          {startProgressPhase === 'planner' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8c8882', fontSize: 13 }}>
                <Spin size="small" />
                🧠 剧情规划师正在分析你的行动...
                <span style={{ fontSize: 12, color: '#b8b3ab', fontFamily: 'monospace', marginLeft: 'auto' }}>
                  {formatElapsed(startElapsedMs)}
                </span>
              </div>
              <div style={{ color: '#5c5751', fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f5f3ef', borderRadius: 8, padding: '12px 14px', border: '1px dashed #ddd8d0' }}>
                {plannerOutput}
                <span style={{ display: 'inline-block', width: 2, height: 14, background: '#d97757', marginLeft: 2, verticalAlign: 'middle', animation: 'blink 1s step-end infinite' }} />
              </div>
            </div>
          )}

          {startProgressPhase === 'error' && (
            <div style={{ padding: '12px 16px', background: '#fff2f0', borderRadius: 8, color: '#ff4d4f', fontSize: 14 }}>
              生成失败：{startProgressError}
            </div>
          )}

          {startProgressPhase === 'cancelled' && (
            <div style={{ padding: '12px 16px', background: '#f5f5f5', borderRadius: 8, color: '#8c8882', fontSize: 14 }}>
              已中断生成
            </div>
          )}
        </div>
      </Modal>

      {/* Header */}
      <div className="agent-chat__header" style={{ borderBottom: '1px solid #eae6df', padding: '16px 24px' }}>
        <div className="agent-chat__title">
          <CompassOutlined style={{ color: '#d97757', fontSize: 18 }} />
          <h3 style={{ margin: 0, fontWeight: 600, color: '#33312e', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sessionTitle}</span>
            {bookTravelStore.selectedMaterialId || bookTravelStore.scenes.length > 0 ? (
              <Tag color="#d97757" style={{ marginLeft: 8, borderRadius: 4, flexShrink: 0, whiteSpace: 'nowrap' }}>
                {bookTravelStore.scenes.length > 0
                  ? `穿书中 · ${bookTravelStore.scenes.find((s) => s.id === bookTravelStore.currentSceneId)?.title || '场景'}`
                  : '穿书准备中'}
              </Tag>
            ) : (
              <span style={{ fontSize: 12, color: '#8c8882', fontWeight: 400, flexShrink: 0, whiteSpace: 'nowrap' }}>
                ({selectedWorldBook?.name || '无世界书'} · {selectedCards.length}个活跃角色{dynamicRoleLoadingEnabled ? ' · 动态加载' : ''})
              </span>
            )}
          </h3>
        </div>

        <div className="agent-chat__header-actions">
          {bookTravelStore.scenes.length > 0 && (
            <Tooltip title="保存当前穿书进度">
              <Button
                type="text"
                disabled={isStreaming}
                icon={<FileProtectOutlined />}
                onClick={() => {
                  bookTravelStore.saveProgress(currentBookTravelSceneTitle);
                  message.success('进度已保存');
                }}
                style={{
                  color: isStreaming ? '#8c8882' : '#d97757',
                  fontWeight: 500,
                  fontSize: 13,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4
                }}
              >
                保存进度
              </Button>
            </Tooltip>
          )}

          <Tooltip title="重开新冒险">
            <Button aria-label="重开新冒险" type="text" icon={<ReloadOutlined />} onClick={restartBookTravelAdventure} />
          </Tooltip>

          <Dropdown
            menu={{
              items: bookTravelStore.savedProgresses.length > 0
                ? bookTravelStore.savedProgresses.map((progress) => ({
                  key: progress.id,
                  label: (
                    <div className="agent-session-menu-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', minWidth: 200, padding: '4px 0' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', marginRight: 16 }}>
                        <strong style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{progress.title}</strong>
                        <span style={{ fontSize: '12px', color: '#999', marginTop: 2 }}>
                          {savedProgressDateFormatter.format(new Date(progress.savedAt))}
                        </span>
                      </div>
                      <Button
                        type="text"
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        onClick={(e) => {
                          e.stopPropagation();
                          bookTravelStore.deleteSavedProgress(progress.id);
                        }}
                      />
                    </div>
                  ),
                }))
                : [{ key: 'empty', disabled: true, label: '暂无保存的穿书进度' }],
              onClick: ({ key }) => {
                if (key !== 'empty') bookTravelStore.loadSavedProgress(String(key));
              },
            }}
            placement="bottomRight"
            trigger={['click']}
          >
            <Tooltip title="穿书保存进度">
              <Button type="text" icon={<HistoryOutlined />} />
            </Tooltip>
          </Dropdown>
        </div>
      </div>

      {/* Unified scrollable content area */}
      <div ref={chatHistoryRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {bookTravelStore.scenes.length > 0 ? (
          <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Turns history */}
            {bookTravelStore.turns.map((turn) => {
              const createdScene = turn.createdSceneId ? bookTravelStore.scenes.find((s) => s.id === turn.createdSceneId) : null;
              const currentScene = bookTravelStore.scenes.find((s) => s.id === bookTravelStore.currentSceneId);
              const sceneContext = createdScene || currentScene;
              const sceneGoals = getPlannerSceneGoals(turn.plannerOutput);
              const userCharacterLabel = bookTravelStore.userCharacter
                ? `${bookTravelStore.userCharacter.name}（${bookTravelStore.userCharacter.identity}）`
                : '';
              const shouldShowSceneBrief = turn.classification === 'change-scene' && (Boolean(userCharacterLabel) || sceneGoals.length > 0);
              const shouldShowSituationCard = shouldShowSceneBrief || Boolean(sceneContext?.currentSituation);
              const canRetryWriter = turn.status === 'error' && turn.failedStage === 'writing';
              return (
                <div key={turn.id} style={{ marginBottom: 24 }}>
                  <div style={{ textAlign: 'right', marginBottom: 8 }}>
                    <div style={{ display: 'inline-block', background: '#d97757', color: '#fff', padding: '10px 14px', borderRadius: '12px 12px 2px 12px', maxWidth: '80%', fontSize: 14, lineHeight: 1.6 }}>
                      {turn.userInput}
                    </div>
                  </div>
                  {sceneContext && (
                    <div style={{ marginBottom: 12, background: '#faf6f0', border: '1px solid #f2e8dc', borderRadius: 10, padding: '14px 16px' }}>
                      <div style={{ fontSize: 15, fontWeight: 600, color: '#33312e', marginBottom: 6 }}>{sceneContext.title}</div>
                      <div style={{ fontSize: 12, color: '#8c8882', marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
                        {sceneContext.time && <span>时间：{sceneContext.time}</span>}
                        {sceneContext.location && <span>地点：{sceneContext.location}</span>}
                      </div>
                      {createdScene && createdScene.summary && (
                        <div style={{ fontSize: 12, color: '#8c8882', marginBottom: 8, fontStyle: 'italic' }}>
                          {createdScene.summary}
                        </div>
                      )}
                      {shouldShowSituationCard && (
                        <div data-testid="scene-situation-card" style={{ fontSize: 12, color: '#5c5751', marginBottom: 8, background: '#fff', padding: '8px 10px', borderRadius: 6 }}>
                          {userCharacterLabel && (
                            <div>
                              <span style={{ color: '#d97757', fontWeight: 600 }}>扮演身份：</span>{userCharacterLabel}
                            </div>
                          )}
                          {sceneGoals.length > 0 && (
                            <div>
                              <span style={{ color: '#d97757', fontWeight: 600 }}>场景目标：</span>{sceneGoals.join('、')}
                            </div>
                          )}
                          {sceneContext.currentSituation && (
                            <div>
                              <span style={{ color: '#d97757', fontWeight: 600 }}>当前局势：</span>{sceneContext.currentSituation}
                            </div>
                          )}
                        </div>
                      )}
                      {sceneContext.activeCharacters && sceneContext.activeCharacters.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {sceneContext.activeCharacters.map((name) => (
                            <Tag key={name} color="#d97757" style={{ borderRadius: 4, margin: 0 }}>{name}</Tag>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {turn.narrativeOutput ? (
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ display: 'inline-block', background: '#fff', border: '1px solid #eae6df', padding: '12px 14px', borderRadius: '12px 12px 12px 2px', maxWidth: '80%', color: '#33312e', fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                        {turn.narrativeOutput}
                      </div>
                      {canRetryWriter && (
                        <div style={{ marginTop: 6 }}>
                          <Button
                            disabled={isBookTravelBusy}
                            icon={<ReloadOutlined />}
                            onClick={() => void retryBookTravelWriter(turn)}
                            size="small"
                            type="text"
                            style={{ color: '#d97757', paddingInline: 6 }}
                          >
                            重试写手
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : turn.status === 'classifying' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8c8882', fontSize: 13, paddingLeft: 4 }}>
                      <Spin size="small" />
                      正在识别行动...
                    </div>
                  ) : null}
                </div>
              );
            })}

            {/* Streaming progress in message stream */}
            {startProgressPhase === 'writer' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '16px', background: '#f5f3ef', borderRadius: 12, border: '1px dashed #ddd8d0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8c8882', fontSize: 13 }}>
                  <Spin size="small" />
                  ✍️ 场景写手正在书写...
                  <span style={{ fontSize: 12, color: '#b8b3ab', fontFamily: 'monospace', marginLeft: 'auto' }}>
                    {formatElapsed(startElapsedMs)}
                  </span>
                </div>
                {(() => {
                  const partial = extractPartialContent(writerOutput);
                  return partial !== null ? (
                    <div style={{ color: '#5c5751', fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fff', borderRadius: 8, padding: '12px 14px', border: '1px solid #eae6df' }}>
                      {partial}
                      <span style={{ display: 'inline-block', width: 2, height: 14, background: '#d97757', marginLeft: 2, verticalAlign: 'middle', animation: 'blink 1s step-end infinite' }} />
                    </div>
                  ) : null;
                })()}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button size="small" onClick={handleCancelStart}>中断</Button>
                </div>
              </div>
            )}
            {startProgressPhase === 'error' && (
              <div style={{ padding: '12px 16px', background: '#fff2f0', borderRadius: 8, color: '#ff4d4f', fontSize: 14 }}>
                生成失败：{startProgressError}
              </div>
            )}
            {startProgressPhase === 'cancelled' && (
              <div style={{ padding: '12px 16px', background: '#f5f5f5', borderRadius: 8, color: '#8c8882', fontSize: 14 }}>
                已中断生成
              </div>
            )}

          </div>
        ) : (
          /* Book Travel Setup Wizard */
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '40px 24px',
            maxWidth: '720px',
            margin: '0 auto',
            width: '100%'
          }}>
            <div style={{ textAlign: 'center', marginBottom: '32px' }}>
              <CompassOutlined style={{ fontSize: '56px', color: '#d97757', marginBottom: '16px', opacity: 0.9 }} />
              <h2 style={{ fontSize: '26px', fontWeight: 600, color: '#33312e', margin: '0 0 8px 0', letterSpacing: '-0.5px' }}>
                穿书页
              </h2>
              <p style={{ color: '#8c8882', fontSize: '15px', margin: 0 }}>
                选择穿书素材与入场点，进入小说世界展开独一无二的剧情体验
              </p>
            </div>

            <div style={{
              width: '100%',
              background: '#ffffff',
              border: '1px solid #eae6df',
              borderRadius: '12px',
              padding: '32px',
              boxShadow: '0 4px 24px rgba(217, 119, 87, 0.02)',
              display: 'flex',
              flexDirection: 'column',
              gap: '24px'
            }}>
              {/* Select Assembled Material */}
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#33312e', marginBottom: '8px' }}>
                  选择穿书素材
                </div>
                {bookTravelStore.assembledMaterials.length === 0 ? (
                  <div style={{ color: '#8c8882', fontSize: '13px', textAlign: 'center', padding: '12px', border: '1px dashed #eae6df', borderRadius: '6px', background: '#faf9f5' }}>
                    暂无已装配素材，请先前往<Button type="link" style={{ padding: 0, height: 'auto' }} onClick={() => navigate('/book-travel-materials')}>穿书素材页</Button>装配素材
                  </div>
                ) : (
                  <Select
                    placeholder="选择一个已装配素材"
                    value={bookTravelStore.selectedMaterialId}
                    onChange={(id) => bookTravelStore.loadAssembledMaterial(id)}
                    style={{ width: '100%' }}
                    options={bookTravelStore.assembledMaterials.map((m) => ({ value: m.id, label: m.title }))}
                  />
                )}
              </div>

              {/* Select Entry Point */}
              {bookTravelStore.selectedMaterialId && bookTravelStore.entryPoints.length > 0 && (
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#33312e', marginBottom: '8px' }}>
                    选择入场点
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {bookTravelStore.entryPoints.map((ep) => {
                      const selected = bookTravelStore.selectedEntryPointId === ep.id;
                      return (
                        <div
                          key={ep.id}
                          onClick={() => bookTravelStore.setSelectedEntryPointId(ep.id)}
                          style={{
                            padding: '12px 14px',
                            borderRadius: 8,
                            border: selected ? '1px solid #d97757' : '1px solid #eae6df',
                            background: selected ? '#fff7f2' : '#ffffff',
                            cursor: 'pointer',
                          }}
                        >
                          <div style={{ fontWeight: 600, color: selected ? '#d97757' : '#33312e', fontSize: 14 }}>{ep.title}</div>
                          <div style={{ fontSize: 12, color: '#8c8882', marginTop: 4 }}>{ep.summary}</div>
                          {ep.risk && <div style={{ fontSize: 12, color: '#ff4d4f', marginTop: 4 }}>风险：{ep.risk}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Select User Character */}
              {bookTravelStore.selectedEntryPointId && (
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#33312e', marginBottom: '8px' }}>
                    选择扮演身份
                  </div>
                  {bookTravelStore.recommendedUserCharacters.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '12px' }}>
                      {bookTravelStore.recommendedUserCharacters.map((uc) => {
                        const selected = bookTravelStore.userCharacter?.name === uc.name;
                        return (
                          <Tag.CheckableTag
                            key={uc.name}
                            checked={selected}
                            onChange={(checked) => {
                              if (checked) bookTravelStore.setUserCharacter(uc);
                            }}
                            style={{
                              padding: '6px 14px',
                              fontSize: '13px',
                              border: selected ? '1px solid #d97757' : '1px solid #eae6df',
                              borderRadius: '6px',
                              backgroundColor: selected ? '#fff7f2' : '#faf9f5',
                              color: selected ? '#d97757' : '#5c5751',
                              margin: 0,
                              cursor: 'pointer'
                            }}
                          >
                            <UserOutlined style={{ marginRight: 6 }} />
                            {uc.name}（{uc.identity}）
                          </Tag.CheckableTag>
                        );
                      })}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <Input
                      placeholder="姓名"
                      value={bookTravelStore.userCharacter?.name || ''}
                      onChange={(e) => bookTravelStore.setUserCharacter({ name: e.target.value, identity: bookTravelStore.userCharacter?.identity || '', goal: bookTravelStore.userCharacter?.goal || '' })}
                      style={{ flex: 1 }}
                    />
                    <Input
                      placeholder="身份"
                      value={bookTravelStore.userCharacter?.identity || ''}
                      onChange={(e) => bookTravelStore.setUserCharacter({ name: bookTravelStore.userCharacter?.name || '', identity: e.target.value, goal: bookTravelStore.userCharacter?.goal || '' })}
                      style={{ flex: 1 }}
                    />
                  </div>
                  <Input.TextArea
                    placeholder="目标（可选）"
                    value={bookTravelStore.userCharacter?.goal || ''}
                    onChange={(e) => bookTravelStore.setUserCharacter({ name: bookTravelStore.userCharacter?.name || '', identity: bookTravelStore.userCharacter?.identity || '', goal: e.target.value })}
                    autoSize={{ minRows: 2, maxRows: 4 }}
                    style={{ marginTop: 8 }}
                  />
                </div>
              )}

              {/* Start Button */}
              <Button
                type="primary"
                size="large"
                icon={<PlayCircleOutlined />}
                onClick={startBookTravelAdventure}
                disabled={!bookTravelStore.selectedMaterialId || !bookTravelStore.selectedEntryPointId || !bookTravelStore.userCharacter?.name?.trim()}
                style={{
                  backgroundColor: (bookTravelStore.selectedMaterialId && bookTravelStore.selectedEntryPointId && bookTravelStore.userCharacter?.name?.trim()) ? '#d97757' : undefined,
                  borderColor: (bookTravelStore.selectedMaterialId && bookTravelStore.selectedEntryPointId && bookTravelStore.userCharacter?.name?.trim()) ? '#d97757' : undefined,
                  borderRadius: '8px',
                  fontWeight: 600,
                  marginTop: '12px'
                }}
              >
                开始穿书
              </Button>
            </div>

            {/* Streaming progress in setup wizard */}
            {startProgressPhase === 'writer' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '16px', background: '#f5f3ef', borderRadius: 12, border: '1px dashed #ddd8d0', marginTop: 16, width: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8c8882', fontSize: 13 }}>
                  <Spin size="small" />
                  ✍️ 场景写手正在书写...
                  <span style={{ fontSize: 12, color: '#b8b3ab', fontFamily: 'monospace', marginLeft: 'auto' }}>
                    {formatElapsed(startElapsedMs)}
                  </span>
                </div>
                {(() => {
                  const partial = extractPartialContent(writerOutput);
                  return partial !== null ? (
                    <div style={{ color: '#5c5751', fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fff', borderRadius: 8, padding: '12px 14px', border: '1px solid #eae6df' }}>
                      {partial}
                      <span style={{ display: 'inline-block', width: 2, height: 14, background: '#d97757', marginLeft: 2, verticalAlign: 'middle', animation: 'blink 1s step-end infinite' }} />
                    </div>
                  ) : null;
                })()}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button size="small" onClick={handleCancelStart}>中断</Button>
                </div>
              </div>
            )}
            {startProgressPhase === 'error' && (
              <div style={{ padding: '12px 16px', background: '#fff2f0', borderRadius: 8, color: '#ff4d4f', fontSize: 14, marginTop: 16, width: '100%' }}>
                生成失败：{startProgressError}
              </div>
            )}
            {startProgressPhase === 'cancelled' && (
              <div style={{ padding: '12px 16px', background: '#f5f5f5', borderRadius: 8, color: '#8c8882', fontSize: 14, marginTop: 16, width: '100%' }}>
                已中断生成
              </div>
            )}

          </div>
        )}
      </div>

      {/* Composer Input Area */}
      {(hasMessages || bookTravelStore.scenes.length > 0) && !bookTravelStore.isCompleted && (
        <div className="agent-composer" style={{
          padding: '16px 24px 24px 24px',
          width: '100%',
          boxSizing: 'border-box'
        }}>
          {/* Formatted Text input helper overlay inside composer box */}
          <div id="agent-composer-box" className="agent-composer__box" style={{
            boxShadow: '0 2px 12px rgba(0, 0, 0, 0.04)',
            border: '1px solid #eae6df',
            borderRadius: '12px',
            background: '#ffffff',
            position: 'relative',
            paddingTop: '40px' // Leave space for Segment Tabs
          }}>

            {/* Input Action Segment Controller */}
            <div style={{
              position: 'absolute',
              top: '8px',
              left: '12px',
              zIndex: 10,
              display: 'flex',
              gap: '6px'
            }}>
              <Radio.Group
                value={inputMode}
                onChange={(e) => setInputMode(e.target.value)}
                size="small"
                buttonStyle="solid"
              >
                <Radio.Button value="speech" style={{ borderRadius: '4px 0 0 4px' }}>
                  <CommentOutlined style={{ marginRight: 4 }} />
                  角色说话
                </Radio.Button>
                <Radio.Button value="behavior">
                  <ExperimentOutlined style={{ marginRight: 4 }} />
                  角色行为
                </Radio.Button>
                <Radio.Button value="plot" style={{ borderRadius: '0 4px 4px 0' }}>
                  <BranchesOutlined style={{ marginRight: 4 }} />
                  剧情客观推进
                </Radio.Button>
              </Radio.Group>
            </div>

            <Input.TextArea
              className="agent-composer__textarea"
              autoSize={{ minRows: 1, maxRows: 8 }}
              disabled={isSessionArchived}
              onChange={(e) => setInput(e.target.value)}
              style={{ zIndex: 2, position: 'relative', background: 'transparent', boxShadow: 'none', border: 'none', padding: '12px 16px 40px 16px', fontSize: '15px' }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={
                isSessionArchived
                  ? "本局冒险记忆已被封存，无法继续发送指令"
                  : bookTravelStore.scenes.length > 0
                    ? inputMode === 'speech'
                      ? "说些什么..."
                      : inputMode === 'behavior'
                        ? "做点什么..."
                        : "推进剧情..."
                    : inputMode === 'speech'
                      ? "以你角色的口吻输入对话内容，按 Cmd/Ctrl + Enter 提交..."
                      : inputMode === 'behavior'
                        ? "描述你角色采取的具体动作（例如：撬门、施法、隐蔽等）..."
                        : "以旁白口吻描述剧情推进（例如：天空突然放晴、怪物发动袭击等）..."
              }
              value={input}
            />

            <div className="agent-composer__actions" style={{ position: 'absolute', bottom: '12px', left: '16px', right: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 3 }}>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {bookTravelStore.scenes.length > 0 ? (
                  <Tooltip title="查看当前状态和剧情回顾">
                    <Button
                      aria-label="状态"
                      icon={<ProfileOutlined />}
                      onClick={showBookTravelStatusModal}
                      size="small"
                      type="text"
                      style={{ color: '#d97757', fontWeight: 500, paddingInline: 8 }}
                    >
                      状态
                    </Button>
                  </Tooltip>
                ) : (
                  <span style={{ fontSize: '12px', color: '#8c8882' }}>
                    当前模式：
                    <Tag color="orange" style={{ margin: 0 }}>
                      {inputMode === 'speech' ? '说话 (我：“内容”)' : inputMode === 'behavior' ? '动作 (（我 内容）)' : '第三方剧情推进'}
                    </Tag>
                  </span>
                )}
              </div>

              <div className="agent-send-cluster" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Tooltip color="#fff" placement="topRight" title={contextTooltip} overlayInnerStyle={{ width: 'max-content', maxWidth: 320, padding: '8px 12px', border: '1px solid #eae6df' }}>
                  <button
                    aria-label="查看上下文"
                    className="agent-context-ring"
                    style={{ '--context-fill': `${contextPercent}%` } as React.CSSProperties}
                    type="button"
                  >
                    <span>{contextPercent}%</span>
                  </button>
                </Tooltip>

                <Tooltip title={isStreaming ? '停止' : isBookTravelBusy ? '正在处理行动' : isSessionArchived ? '当前故事已归档' : '提交行动'}>
                  <Button
                    className="de-ai-agent-run-button"
                    disabled={isSessionArchived || isBookTravelBusy || (!isStreaming && !input.trim())}
                    icon={isStreaming ? <StopOutlined /> : <PlayCircleOutlined />}
                    onClick={isStreaming ? handleStop : handleSend}
                    shape="circle"
                    type={isStreaming ? "default" : "primary"}
                    danger={isStreaming}
                    style={isStreaming ? undefined : {
                      backgroundColor: '#d97757',
                      borderColor: '#d97757',
                      color: '#ffffff'
                    }}
                  />
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function updateMessageTool(
  messages: Message[],
  messageId: string,
  tool: AgentToolEntry,
  mode: 'start' | 'output' | 'end',
) {
  return messages.map((msg) => {
    if (msg.id !== messageId) {
      return msg;
    }
    const tools = [...(msg.tools ?? [])];
    const index = tool.id
      ? tools.findIndex((entry) => entry.id === tool.id)
      : tools.length - 1;
    if (mode === 'start' || index < 0) {
      return { ...msg, tools: [...tools, tool] };
    }

    const current = tools[index];
    const prevResult = current.result === '正在执行工具' ? '' : current.result;
    tools[index] = {
      ...current,
      name: tool.name || current.name,
      status: tool.status || current.status,
      arguments: tool.arguments || current.arguments,
      result: mode === 'output'
        ? `${prevResult}${tool.result}`
        : tool.result || current.result,
    };
    return { ...msg, tools };
  });
}
export default Story;

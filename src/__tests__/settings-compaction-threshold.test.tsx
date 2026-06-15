import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import Settings from '../pages/Settings';
import { defaultAgentConfigs, useSettingsStore } from '../stores/useSettingsStore';

const thresholdLabel = '自动压缩轮数';

function cardByTitle(title: string) {
  const titleNode = screen.getByText(title);
  const card = titleNode.closest('.ant-card');
  if (!card) {
    throw new Error(`Card not found: ${title}`);
  }
  return within(card as HTMLElement);
}

describe('Settings compaction turn threshold', () => {
  beforeEach(() => {
    act(() => {
      useSettingsStore.setState({
        agentConfigs: defaultAgentConfigs,
      });
    });
  });

  it('renders threshold only on chat and adventure agent cards', () => {
    render(<Settings />);

    expect(screen.getAllByText(thresholdLabel)).toHaveLength(3);
    expect(cardByTitle('伴侣对谈师').getByText(thresholdLabel)).toBeInTheDocument();
    expect(cardByTitle('冒险主持人（非动态加载）').getByText(thresholdLabel)).toBeInTheDocument();
    expect(cardByTitle('冒险主持人（角色卡动态加载）').getByText(thresholdLabel)).toBeInTheDocument();
    expect(cardByTitle('写文章 Agent').queryByText(thresholdLabel)).not.toBeInTheDocument();
  });

  it('saves and resets the chat agent threshold', async () => {
    render(<Settings />);

    const chatCard = cardByTitle('伴侣对谈师');
    const spinButtons = chatCard.getAllByRole('spinbutton');
    const thresholdInput = spinButtons[spinButtons.length - 1];
    expect(thresholdInput).toBeDefined();
    fireEvent.change(thresholdInput!, { target: { value: '12' } });
    fireEvent.click(chatCard.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(useSettingsStore.getState().agentConfigs.partnerChat.compactionTurnThreshold).toBe(12);
    });

    fireEvent.click(chatCard.getByRole('button', { name: '恢复默认' }));

    await waitFor(() => {
      expect(useSettingsStore.getState().agentConfigs.partnerChat.compactionTurnThreshold).toBe(20);
    });
  });
});

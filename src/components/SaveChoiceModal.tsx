import React, { useLayoutEffect, useState } from 'react';
import { Alert, Input, Modal, Radio, Select, Space } from 'antd';

export type SaveChoiceMode = 'create' | 'overwrite';

export interface SaveChoiceConfirmPayload {
  mode: SaveChoiceMode;
  name: string;
  targetId: string | null;
}

export interface SaveChoiceOverwriteTarget {
  value: string;
  label: string;
  description?: string;
  details?: string[];
}

interface SaveChoiceModalProps {
  open: boolean;
  title: string;
  nameLabel: string;
  initialName: string;
  loading?: boolean;
  overwriteAvailable: boolean;
  createLabel?: string;
  overwriteLabel?: string;
  overwriteTargetLabel?: string;
  overwriteTargets?: SaveChoiceOverwriteTarget[];
  initialOverwriteTargetId?: string | null;
  unavailableOverwriteText?: string;
  onCancel: () => void;
  onConfirm: (payload: SaveChoiceConfirmPayload) => void;
}

export const SaveChoiceModal: React.FC<SaveChoiceModalProps> = ({
  open,
  title,
  nameLabel,
  initialName,
  loading = false,
  overwriteAvailable,
  createLabel = '保存为新记录',
  overwriteLabel = '覆盖原记录',
  overwriteTargetLabel = '覆盖记录',
  overwriteTargets = [],
  initialOverwriteTargetId = null,
  unavailableOverwriteText = '当前没有可覆盖的原记录，将保存为新记录。',
  onCancel,
  onConfirm,
}) => {
  const [mode, setMode] = useState<SaveChoiceMode | null>(null);
  const [name, setName] = useState(initialName);
  const [targetId, setTargetId] = useState<string | null>(initialOverwriteTargetId);
  const selectedMode: SaveChoiceMode = mode ?? (overwriteAvailable ? 'overwrite' : 'create');
  const selectedTargetId = targetId || overwriteTargets[0]?.value || null;
  const overwriteTargetValuesKey = overwriteTargets.map((target) => target.value).join('|');
  const selectOptions = overwriteTargets.map((target) => ({
    value: target.value,
    label: target.label,
  }));

  useLayoutEffect(() => {
    if (!open) return;
    setMode(overwriteAvailable ? 'overwrite' : 'create');
    setName(initialName);
    setTargetId(
      initialOverwriteTargetId && overwriteTargets.some((target) => target.value === initialOverwriteTargetId)
        ? initialOverwriteTargetId
        : overwriteTargets[0]?.value || null,
    );
  }, [initialName, initialOverwriteTargetId, open, overwriteAvailable, overwriteTargetValuesKey]);

  const confirmDisabled = (
    (selectedMode === 'create' && name.trim() === '') ||
    (selectedMode === 'overwrite' && overwriteTargets.length > 0 && !selectedTargetId)
  );

  return (
    <Modal
      open={open}
      title={title}
      centered
      width={460}
      okText="确认保存"
      cancelText="取消"
      confirmLoading={loading}
      okButtonProps={{ disabled: confirmDisabled }}
      onCancel={onCancel}
      onOk={() => onConfirm({ mode: selectedMode, name: name.trim(), targetId: selectedTargetId })}
      styles={{ body: { paddingTop: 12 } }}
    >
      <Space orientation="vertical" size={14} style={{ width: '100%' }}>
        <Radio.Group
          value={selectedMode}
          onChange={(event) => setMode(event.target.value)}
          style={{ display: 'grid', gap: 8 }}
        >
          <Radio value="create">{createLabel}</Radio>
          <Radio value="overwrite" disabled={!overwriteAvailable}>{overwriteLabel}</Radio>
        </Radio.Group>
        {!overwriteAvailable && (
          <Alert type="info" showIcon message={unavailableOverwriteText} />
        )}
        {selectedMode === 'create' && (
          <label style={{ display: 'grid', gap: 6, color: '#33312e', fontWeight: 600 }}>
            {nameLabel}
            <Input
              aria-label={nameLabel}
              value={name}
              maxLength={80}
              placeholder={`请输入${nameLabel}`}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        {selectedMode === 'overwrite' && overwriteTargets.length > 0 && (
          <label style={{ display: 'grid', gap: 6, color: '#33312e', fontWeight: 600 }}>
            {overwriteTargetLabel}
            <Select
              aria-label={overwriteTargetLabel}
              value={selectedTargetId}
              options={selectOptions}
              listHeight={320}
              optionRender={(option) => {
                const target = overwriteTargets.find((item) => item.value === option.value);
                if (!target) return option.label;
                return (
                  <div style={{ display: 'grid', gap: 5, padding: '4px 0' }}>
                    <div style={{ color: '#33312e', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {target.label}
                    </div>
                    {target.description && (
                      <div style={{ color: '#8c8882', fontSize: 12, lineHeight: 1.45, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {target.description}
                      </div>
                    )}
                    {target.details && target.details.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {target.details.slice(0, 4).map((detail) => (
                          <span
                            key={detail}
                            style={{
                              maxWidth: '100%',
                              color: '#6f6962',
                              background: '#faf7f1',
                              borderRadius: 4,
                              padding: '2px 6px',
                              fontSize: 12,
                              lineHeight: 1.45,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {detail}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }}
              onChange={(value) => setTargetId(value)}
            />
          </label>
        )}
      </Space>
    </Modal>
  );
};

export default SaveChoiceModal;

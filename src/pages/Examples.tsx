import React from 'react';
import ExamplesDirectory from '../components/ExamplesDirectory';
import MarkdownEditor from '../components/MarkdownEditor';
import { useDeAiStore } from '../stores/useDeAiStore';

const DIRECTORY_WIDTH = 300;
const EDITOR_MIN_WIDTH = 400;

const Examples: React.FC = () => {
  const { selectedReferenceFile } = useDeAiStore();

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', overflow: 'hidden', background: '#faf9f5' }}>
      <div style={{ width: DIRECTORY_WIDTH, minWidth: DIRECTORY_WIDTH, borderRight: '1px solid rgba(0, 0, 0, 0.04)', display: 'flex', flexDirection: 'column' }}>
        <ExamplesDirectory />
      </div>

      <div style={{ flex: 1, minWidth: EDITOR_MIN_WIDTH, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <MarkdownEditor
            filePath={selectedReferenceFile}
            readOnly={false}
          />
        </div>
      </div>
    </div>
  );
};

export default Examples;

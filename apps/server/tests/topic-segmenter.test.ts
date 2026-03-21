import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/db/index.js', () => ({
    getDb: () => ({
        prepare: () => ({
            all: () => [],
            run: () => {},
            get: () => null,
        }),
    }),
}));

import { detectTopic, scoreProjectRelevance } from '../src/engine/topic-segmenter.js';

describe('detectTopic', () => {
    it('detects db-work topics', () => {
        const session = { title: 'Fix SQL migration for users table', raw_data: '{}', top_tools: '[]' };
        expect(detectTopic(session)).toBe('db-work');
    });

    it('detects frontend topics', () => {
        const session = { title: 'Build React component with Tailwind', raw_data: '{}', top_tools: '[]' };
        expect(detectTopic(session)).toBe('frontend');
    });

    it('detects debugging topics', () => {
        const session = { title: 'Fix null pointer exception in auth', raw_data: '{}', top_tools: '[]' };
        expect(detectTopic(session)).toBe('debugging');
    });

    it('detects devops topics', () => {
        const session = { title: 'Setup Docker CI/CD pipeline', raw_data: '{}', top_tools: '[]' };
        expect(detectTopic(session)).toBe('devops');
    });

    it('detects writing topics', () => {
        const session = { title: 'Write documentation for API', raw_data: '{}', top_tools: '[]' };
        expect(detectTopic(session)).toBe('writing');
    });

    it('detects testing topics', () => {
        const session = { title: 'Add vitest coverage for scorer', raw_data: '{}', top_tools: '[]' };
        expect(detectTopic(session)).toBe('testing');
    });

    it('detects API topics', () => {
        const session = { title: 'Create REST endpoint for dashboard', raw_data: '{}', top_tools: '[]' };
        expect(detectTopic(session)).toBe('api');
    });

    it('detects planning topics', () => {
        const session = { title: 'Architect the new design spec', raw_data: '{}', top_tools: '[]' };
        expect(detectTopic(session)).toBe('planning');
    });

    it('falls back to general', () => {
        const session = { title: 'Random conversation', raw_data: '{}', top_tools: '[]' };
        expect(detectTopic(session)).toBe('general');
    });

    it('considers files in raw_data', () => {
        const session = {
            title: 'Work on project',
            raw_data: JSON.stringify({ filesEdited: ['schema.sql', 'migrate.ts'] }),
            top_tools: '[]',
        };
        expect(detectTopic(session)).toBe('db-work');
    });

    it('handles missing fields gracefully', () => {
        expect(detectTopic({})).toBe('general');
        expect(detectTopic({ title: null, raw_data: null, top_tools: null })).toBe('general');
    });
});

describe('scoreProjectRelevance', () => {
    it('returns 0.5 for null project name', () => {
        expect(scoreProjectRelevance({}, null)).toBe(0.5);
    });

    it('returns high score when title matches project', () => {
        const session = { title: 'OCD dashboard improvements', raw_data: '{}' };
        expect(scoreProjectRelevance(session, 'ocd')).toBe(0.9);
    });

    it('returns high score when files match project', () => {
        // File paths are included in the corpus, so normalized match (0.9) takes precedence
        const session = {
            title: 'Some task',
            raw_data: JSON.stringify({ filesEdited: ['/home/user/myapp/src/index.ts'] }),
        };
        expect(scoreProjectRelevance(session, 'myapp')).toBe(0.9);
    });

    it('returns low score for writing/planning with no files', () => {
        const session = { title: 'Write documentation notes', raw_data: '{}', top_tools: '[]' };
        expect(scoreProjectRelevance(session, 'myproject')).toBe(0.2);
    });

    it('returns default for unrelated sessions', () => {
        const session = { title: 'Unrelated work', raw_data: '{}', top_tools: '[]' };
        expect(scoreProjectRelevance(session, 'myproject')).toBe(0.5);
    });
});

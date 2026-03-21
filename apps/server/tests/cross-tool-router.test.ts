import { describe, it, expect, vi } from 'vitest';

// Mock the db dependency
vi.mock('../src/db/index.js', () => ({
    getDb: () => ({
        prepare: () => ({
            all: () => [],
            run: () => {},
        }),
    }),
}));

import { classifySession } from '../src/engine/cross-tool-router.js';

describe('classifySession', () => {
    it('classifies migration tasks', () => {
        const session = { title: 'Create database migration for users table', raw_data: '{}', total_turns: 10 };
        const result = classifySession(session);
        expect(result.taskType).toBe('migration');
        expect(result.complexity).toBe('simple');
    });

    it('classifies component tasks', () => {
        const session = { title: 'Build React modal component', raw_data: JSON.stringify({ filesEdited: ['Modal.tsx'] }), total_turns: 25 };
        const result = classifySession(session);
        expect(result.taskType).toBe('component');
        expect(result.language).toBe('typescript');
    });

    it('classifies debug tasks', () => {
        const session = { title: 'Fix crash on login page', raw_data: '{}', total_turns: 15 };
        const result = classifySession(session);
        expect(result.taskType).toBe('debug');
    });

    it('classifies refactor tasks', () => {
        const session = { title: 'Refactor auth module', raw_data: '{}', total_turns: 8 };
        const result = classifySession(session);
        expect(result.taskType).toBe('refactor');
    });

    it('classifies test tasks', () => {
        const session = { title: 'Write vitest tests for scorer', raw_data: '{}', total_turns: 12 };
        const result = classifySession(session);
        expect(result.taskType).toBe('test');
    });

    it('classifies API tasks', () => {
        const session = { title: 'Add new endpoint for user profile', raw_data: '{}', total_turns: 6 };
        const result = classifySession(session);
        expect(result.taskType).toBe('api');
    });

    it('classifies devops tasks', () => {
        const session = { title: 'Setup Docker deployment', raw_data: '{}', total_turns: 3 };
        const result = classifySession(session);
        expect(result.taskType).toBe('devops');
        expect(result.complexity).toBe('trivial');
    });

    it('falls back to general for unknown tasks', () => {
        const session = { title: 'Update readme', raw_data: '{}', total_turns: 2 };
        const result = classifySession(session);
        expect(result.taskType).toBe('general');
    });

    it('detects Python language', () => {
        const session = { title: 'Build FastAPI service', raw_data: '{}', total_turns: 10 };
        const result = classifySession(session);
        expect(result.language).toBe('python');
    });

    it('detects SQL language', () => {
        const session = { title: 'Write SELECT query for reports', raw_data: '{}', total_turns: 5 };
        const result = classifySession(session);
        expect(result.language).toBe('sql');
    });

    it('maps complexity levels correctly', () => {
        expect(classifySession({ title: 'test', raw_data: '{}', total_turns: 2 }).complexity).toBe('trivial');
        expect(classifySession({ title: 'test', raw_data: '{}', total_turns: 10 }).complexity).toBe('simple');
        expect(classifySession({ title: 'test', raw_data: '{}', total_turns: 30 }).complexity).toBe('moderate');
        expect(classifySession({ title: 'test', raw_data: '{}', total_turns: 80 }).complexity).toBe('complex');
    });

    it('handles missing raw_data gracefully', () => {
        const session = { title: 'Some task', total_turns: 5 };
        const result = classifySession(session);
        expect(result).toHaveProperty('taskType');
        expect(result).toHaveProperty('complexity');
    });

    it('handles malformed raw_data gracefully', () => {
        const session = { title: 'Some task', raw_data: 'not json', total_turns: 5 };
        const result = classifySession(session);
        expect(result).toHaveProperty('taskType');
    });
});

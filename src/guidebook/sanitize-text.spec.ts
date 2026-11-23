import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { sanitizeText } from './sanitize-text';
import { UpdateGuidebookDto } from './dto/update-guidebook.dto';

describe('sanitizeText', () => {
  it('leaves plain text unchanged', () => {
    expect(sanitizeText('Wifi password: abc123')).toBe('Wifi password: abc123');
  });

  it('strips tags but keeps inner text', () => {
    expect(sanitizeText('<b>x</b>')).toBe('x');
    expect(sanitizeText('a <i>b</i> c')).toBe('a b c');
  });

  it('removes script and style with their content', () => {
    expect(sanitizeText('<script>alert(1)</script>')).toBe('');
    expect(sanitizeText('hi<style>p{color:red}</style>there')).toBe('hithere');
    expect(sanitizeText('<iframe src="x">y</iframe>ok<object>o</object><embed>e</embed>')).toBe('ok');
  });

  it('handles uppercase and multiline tags', () => {
    expect(sanitizeText('<SCRIPT\n type="x">\nalert(1)\n</SCRIPT >after')).toBe('after');
  });

  it('handles nested and malformed tags', () => {
    expect(sanitizeText('<scr<script>ipt>alert(1)</script>')).not.toMatch(/alert|<script/i);
    expect(sanitizeText('<<b>script>alert(1)')).not.toMatch(/alert/);
    expect(sanitizeText('<script><script>a</script>b</script>c')).not.toMatch(/<|alert/);
  });

  it('handles > inside quoted attributes', () => {
    expect(sanitizeText('<a title="a>b">link</a>')).toBe('link');
    expect(sanitizeText('<script data-x="a>b">alert(1)</script>ok')).toBe('ok');
  });

  it('removes an unclosed script to the end', () => {
    expect(sanitizeText('safe <script>alert(1)')).toBe('safe');
    expect(sanitizeText('safe <script src="x"')).toBe('safe');
  });

  it('keeps newlines, collapses extra whitespace', () => {
    expect(sanitizeText('  line1  \r\n\n\n\n  line2\t\tend  ')).toBe('line1\n\nline2 end');
  });

  it('preserves unicode', () => {
    expect(sanitizeText('<b>वाईफाई पासवर्ड</b> नमस्ते')).toBe('वाईफाई पासवर्ड नमस्ते');
  });

  it('does not decode entities', () => {
    expect(sanitizeText('&lt;b&gt;')).toBe('&lt;b&gt;');
  });
});

describe('UpdateGuidebookDto', () => {
  const run = (sections: unknown[]) => {
    const dto = plainToInstance(UpdateGuidebookDto, { sections });
    return { dto, errors: validateSync(dto) };
  };

  it('sanitises then accepts', () => {
    const { dto, errors } = run([{ title: '<b>Hi</b>', body: 'x<script>y</script>' }]);
    expect(errors).toHaveLength(0);
    expect(dto.sections[0]).toMatchObject({ title: 'Hi', body: 'x' });
  });

  it('rejects empty after cleaning', () => {
    expect(run([{ title: '<script>a</script>', body: 'ok' }]).errors.length).toBeGreaterThan(0);
  });

  it('applies length caps after cleaning', () => {
    const okTitle = `<b>${'a'.repeat(80)}</b>`;
    expect(run([{ title: okTitle, body: 'ok' }]).errors).toHaveLength(0);
    expect(run([{ title: 'a'.repeat(81), body: 'ok' }]).errors.length).toBeGreaterThan(0);
    expect(run([{ title: 't', body: 'a'.repeat(2001) }]).errors.length).toBeGreaterThan(0);
  });

  it('rejects more than 12 sections', () => {
    const many = Array.from({ length: 13 }, () => ({ title: 't', body: 'b' }));
    expect(run(many).errors.length).toBeGreaterThan(0);
  });
});

describe('sanitizeText performance', () => {
  it.each([['<a '], ['<a"'], ['<script '], ["<a '"]])('handles 90k of %s quickly', (unit) => {
    const input = unit.repeat(Math.ceil(90_000 / unit.length));
    const start = Date.now();
    sanitizeText(input);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('handles repeated unclosed <script> at the DTO raw bound quickly', () => {
    const start = Date.now();
    sanitizeText('<script>'.repeat(1000));
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('rejects oversized raw input without sanitising', () => {
    const dto = plainToInstance(UpdateGuidebookDto, {
      sections: [{ title: '<a '.repeat(30_000), body: '<script '.repeat(11_000) }],
    });
    const start = Date.now();
    const errors = validateSync(dto, { whitelist: true });
    expect(Date.now() - start).toBeLessThan(200);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('guidebook unlocking statuses', () => {
  it('keeps disputed stays unlocked but not checked_out', () => {
    const { UNLOCKING_STATUSES } = require('./guidebook.service');
    expect(UNLOCKING_STATUSES).toContain('disputed');
    expect(UNLOCKING_STATUSES).not.toContain('checked_out');
  });
});

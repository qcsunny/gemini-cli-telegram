/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface RichText {
  text: string;
}

export type RichBlock =
  | {
      type: 'paragraph';
      text: RichText;
    }
  | {
      type: 'section_heading';
      level: 1 | 2 | 3;
      text: RichText;
    }
  | {
      type: 'preformatted';
      text: string;
      language?: string;
    }
  | {
      type: 'block_quotation';
      text: RichText;
      is_collapsible?: boolean;
    }
  | {
      type: 'divider';
    }
  | {
      type: 'list';
      items: Array<{ type: 'list_item'; text: RichText }>;
    }
  | {
      type: 'table';
      cells: Array<
        Array<{
          text: RichText;
          is_header?: boolean;
          align?: 'left' | 'center' | 'right';
          valign?: 'top' | 'middle' | 'bottom';
        }>
      >;
      is_bordered?: boolean;
      is_striped?: boolean;
    };

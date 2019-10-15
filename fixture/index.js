import squareArea from './square.js';
import circleArea from './circle.js';

import { createElement, render } from 'preact';
import './style.css';
export const PI = 3.141;

render(
  createElement(
    'p',
    {},
    createElement('p', { class: 'square' }, 'area of square: ' + squareArea(5)),
    createElement('p', { class: 'circle' }, 'area of circle: ' + circleArea(5))
  ),
  document.getElementById('root')
);

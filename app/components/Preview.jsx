import React, { PropTypes, Component } from 'react';
import marked from 'marked';
import emojify from 'emojify.js';

const { string } = PropTypes;

export default class Preview extends Component {
  constructor(props, context) {
    super(props, context);

    emojify.setConfig({
      img_dir: 'https://github.global.ssl.fastly.net/images/icons/emoji/'
    });
  }

  update() {
    var html = marked(this.props.raw.toString(), { sanitize: true });

    html = emojify.replace(html);

    return {
      __html: html
    };
  }

  render() {
    return (
      <div className="preview">
        <div
          className="rendered"
          dangerouslySetInnerHTML={this.update()} />
      </div>
    );
  }
}

Preview.propTypes = {
  raw: string.isRequired
}
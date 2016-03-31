import localforage from 'localforage';
import uuid from 'uuid';
import sjcl from 'sjcl';
import request from 'superagent';

const { Promise } = global;

export const Events = {
  NO_DOCUMENT_ID: 'store:no-document-id',
  DOCUMENT_NOT_FOUND: 'store:document-not-found',
  APP_IS_OFFLINE: 'store:app-is-offline',
  APP_IS_ONLINE: 'store:app-is-online',
  CHANGE: 'store:change',
  SYNCHRONIZE: 'store:synchronize',
  DECRYPTION_FAILED: 'store:decryption_failed',
  CONFLICT: 'store:conflict',
  UPDATE_WITHOUT_CONFLICT: 'store:update-without-conflict'
};

export default class Store {

  constructor(name, events, endpoint) {
    this.state = {
      document: {
        uuid: uuid.v4(),
        content: DEFAULT_CONTENT
      },
      secret: sjcl.codec.base64.fromBits(sjcl.random.randomWords(8, 10), 0)
    };

    this.events = events;
    this.endpoint = endpoint;

    localforage.config({
      name: 'monod',
      storeName: name
    });
  }

  findById(id, secret) {
    if (!id) {
      this.events.emit(Events.NO_DOCUMENT_ID, this.state);

      return;
    }

    localforage
      .getItem(id)
      .then((document) => {
        if (null === document) {
          return Promise.reject('document not found');
        }

        this
          ._decrypt(document.content, secret)
          .then((content) => {
            document.content  = content;
            this.state.secret = secret;

            this.update(document, false);
          });
      })
      .catch(() => {
        request
          .get(`${this.endpoint}/documents/${id}`)
          .set('Accept', 'application/json')
          .set('Content-Type', 'application/json')
          .end((err, res) => {
            if (err) {
              this.events.emit(Events.APP_IS_OFFLINE, this.state);
            }

            if (err || 200 !== res.statusCode) {
              // `err` might be handled differently in the future
              this.events.emit(Events.DOCUMENT_NOT_FOUND, this.state);

              return;
            }

            const document = res.body;
            this
              ._decrypt(document.content, secret)
              .then((content) => {
                document.content  = content;
                this.state.secret = secret;

                this.update(document, false);
              });

            this.events.emit(Events.APP_IS_ONLINE);
          })
      });
  }

  update(document, updateLastLocalPersist) {
    // we don't want to store default content
    if (DEFAULT_CONTENT === document.content) {
      return;
    }

    this.state.document = Object.assign({}, document);

    if (updateLastLocalPersist) {
      this.state.document.last_local_persist = Date.now();
    }

    this._localPersist();

    this.events.emit(Events.CHANGE, this.state);
  }

  sync() {
    if (DEFAULT_CONTENT === this.state.document.content) {
      return;
    }

    // document is new
    if (!this.state.document.last_modified) {
      this._serverPersist();
    } else {
      request
        .get(`${this.endpoint}/documents/${this.state.document.uuid}`)
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .end((err, res) => {
          // `err` is not null if request fails (e.g., status code = 400),
          // but `res` if undefined when the request fails because of the
          // network.
          if (err) {
            if (!res) {
              this.events.emit(Events.APP_IS_OFFLINE);
            }

            return;
          }

          const serverDocument = res.body;
          const localDocument  = Object.assign({}, this.state.document);

          if (serverDocument.last_modified === localDocument.last_modified) {
            // here, documents are equal on both local and remote sides so we
            // can probably push safely
            if (serverDocument.last_modified < localDocument.last_local_persist) {
              this._serverPersist();
            }
          } else {
            if (serverDocument.last_modified > localDocument.last_modified) {
              if (
                !localDocument.last_local_persist ||
                serverDocument.last_modified > localDocument.last_local_persist
              ) {
                this
                  ._decrypt(serverDocument.content, this.state.secret)
                  .then((content) => {
                    localDocument.content = content;

                    this.update(localDocument, false);

                    this.events.emit(Events.UPDATE_WITHOUT_CONFLICT, {
                      document: localDocument
                    });
                  });

                return;
              }

              // generate a new secret for backup'ed document
              const secret = sjcl.codec.base64.fromBits(sjcl.random.randomWords(8, 10), 0);

              // copy current document
              this
                ._encrypt(localDocument.content, secret)
                .then((content) => {
                  const backup = Object.assign({}, localDocument);
                  backup.uuid  = uuid.v4();
                  backup.content = content;
                  backup.last_modified = null;

                  // persist backup'ed document
                  localforage.setItem(backup.uuid, backup).then(() => {
                    // now, update current doc with server content
                    this
                      ._decrypt(serverDocument.content, this.state.secret)
                      .then((content) => {
                        this.state.document.content = content;
                        // update last_modified so that we are fully sync'ed with
                        // server now
                        this.state.document.last_modified = serverDocument.last_modified;

                        // persist locally
                        localforage.setItem(
                          this.state.document.uuid,
                          this.state.document
                        ).then(() => {
                          this.events.emit(Events.CONFLICT, {
                            old: {
                              document: backup,
                              secret: secret
                            },
                            new: {
                              document: this.state.document,
                              secret: this.state.secret
                            }
                          });
                        });
                      });
                    });
                });
            }
          }
        });
    }
  }

  _decrypt(content, secret) {
    try {
      return Promise.resolve(sjcl.decrypt(secret, content));
    } catch (e) {
      this.events.emit(Events.DECRYPTION_FAILED, this.state);

      return Promise.reject('decryption failed');
    }
  }

  _encrypt(content, secret) {
    return Promise.resolve(sjcl.encrypt(secret, content, { ks: 256 }));
  }

  _localPersist() {
    this
      ._encrypt(this.state.document.content, this.state.secret)
      .then((content) => {
        const document = Object.assign({}, this.state.document);
        document.content = content;

        localforage.setItem(document.uuid, document);
      });
  }

  _serverPersist() {
    this
      ._encrypt(this.state.document.content, this.state.secret)
      .then((content) => {
        const document = Object.assign({}, this.state.document);
        document.content = content;

        request
          .put(`${this.endpoint}/documents/${document.uuid}`)
          .set('Accept', 'application/json')
          .set('Content-Type', 'application/json')
          .send({
            content: content
          })
          .end((err, res) => {
            if (err) {
              this.events.emit(Events.APP_IS_OFFLINE);

              return;
            }

            this.state.document.last_modified = res.body.last_modified;
            this._localPersist();

            this.events.emit(Events.SYNCHRONIZE, { date: new Date() });
            this.events.emit(Events.APP_IS_ONLINE);
          });
      }
    );
  }
}

const DEFAULT_CONTENT = [
  'Introducing Monod',
  '=================',
  '',
  '> **TL;DR** This editor is the first experiment we wanted to tackle at **Le lab**. This _week #1 release_ is a pure client-side application written with [React](https://facebook.github.io/react/) by the good folks at [TailorDev](https://tailordev.fr)!',
  '',
  'Read more about how and why we built Monod at: https://tailordev.fr/blog/.',
  '',
  'See, we have code & Emoji support, yay! :clap:',
  '',
  '``` python',
  'def hello():',
  '    print("Have fun with Monod!")',
  '```',
  '',
  '*Play with this page and [send us feedback](mailto:hello@tailordev.fr?subject=About Monod). We would :heart: to hear from you!*'
].join('\n');

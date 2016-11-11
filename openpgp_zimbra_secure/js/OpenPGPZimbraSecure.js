/*
 * ***** BEGIN LICENSE BLOCK *****
 * OpenPGP Zimbra Secure is the open source digital signature and encrypt for Zimbra Collaboration Open Source Edition software
 * Copyright (C) 2016-present OpenPGP Zimbra Secure

 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * any later version.

 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>
 * ***** END LICENSE BLOCK *****
 *
 * OpenPGP MIME Secure Email Zimlet
 *
 * Written by nguyennv1981@gmail.com
 */

var OPENPGP_SECURITY_TYPES = [
    {label: openpgp_zimbra_secure.dontSignMessage, className: 'DontSign'},
    {label: openpgp_zimbra_secure.signMessage, className: 'Sign'},
    {label: openpgp_zimbra_secure.signAndEncryptMessage, className: 'SignEncrypt'}
];

function openpgp_zimbra_secure_HandlerObject() {
    this._msgDivCache = {};
    this._pgpMessageCache = appCtxt.isChildWindow ? window.opener.openpgp_zimbra_secure_HandlerObject.getInstance()._pgpMessageCache : {};
    this._patchedFuncs = {};
    this._pendingAttachments = [];
    this._pgpAttachments = {};
    this._pgpKeys = new OpenPGPSecureKeys(this);
    this._securePassword = '';
    var pwdKey = 'openpgp_secure_password_' + this.getUsername();
    if (localStorage[pwdKey]) {
        this._securePassword = localStorage[pwdKey];
    }
    else {
        localStorage[pwdKey] = this._securePassword = OpenPGPUtils.randomString({
            length: 24
        });
    }
};

openpgp_zimbra_secure_HandlerObject.prototype = new ZmZimletBase();
openpgp_zimbra_secure_HandlerObject.prototype.constructor = openpgp_zimbra_secure_HandlerObject;

openpgp_zimbra_secure_HandlerObject.prototype.toString = function() {
    return 'openpgp_zimbra_secure_HandlerObject';
};

var OpenPGPZimbraSecure = openpgp_zimbra_secure_HandlerObject;

OpenPGPZimbraSecure.BUTTON_CLASS = 'openpgp_zimbra_secure_button';
OpenPGPZimbraSecure.PREF_SECURITY = 'OPENPGP_SECURITY';
OpenPGPZimbraSecure.USER_SECURITY = 'OPENPGP_USER_SECURITY';

OpenPGPZimbraSecure.OPENPGP_DONTSIGN = 0;
OpenPGPZimbraSecure.OPENPGP_SIGN = 1;
OpenPGPZimbraSecure.OPENPGP_SIGNENCRYPT = 2;

OpenPGPZimbraSecure.prototype.init = function() {
    var self = this;

    AjxDispatcher.addPackageLoadFunction('MailCore', new AjxCallback(this, function(){
        var sendMsgFunc = ZmMailMsg.prototype._sendMessage;
        ZmMailMsg.prototype._sendMessage = function(params) {
            self._sendMessage(sendMsgFunc, this, params);
        }

        var fetchMsgFunc = ZmMailMsg._handleResponseFetchMsg;
        ZmMailMsg._handleResponseFetchMsg = function(callback, result) {
            var newCallback = new AjxCallback(this, function(newResult) {
                fetchMsgFunc.call(this, callback, newResult || result);
            });
            self._handleMessageResponse(newCallback, result);
        };

        var responseLoadMsgsFunc = ZmConv.prototype._handleResponseLoadMsgs;
        ZmConv.prototype._handleResponseLoadMsgs = function(callback, result) {
            var newCallback = new AjxCallback(this, function(newResult) {
                responseLoadMsgsFunc.call(this, callback, newResult || result);
            });
            self._handleMessageResponse(newCallback, result);
        };
    }));

    AjxDispatcher.addPackageLoadFunction('Startup1_2', new AjxCallback(this, function() {
        var self = this;

        var responseGetConvFunc = ZmSearch.prototype._handleResponseGetConv;
        ZmSearch.prototype._handleResponseGetConv = function(callback, result) {
            var newCallback = new AjxCallback(this, function(newResult) {
                responseGetConvFunc.call(this, callback, newResult || result);
            });
            self._handleMessageResponse(newCallback, result);
        };

        var responseExecuteFunc = ZmSearch.prototype._handleResponseExecute;
        ZmSearch.prototype._handleResponseExecute = function(callback, result) {
            var newCallback = new AjxCallback(this, function(newResult) {
                responseExecuteFunc.call(this, callback, newResult || result);
            });
            self._handleMessageResponse(newCallback, result);
        };
    }));

    this._addJsScripts([
        'js/openpgpjs/openpgp.min.js',
        'js/mimemessage/mimemessage.js'
    ], new AjxCallback(function() {
        self._initOpenPGP();
    }));
};

OpenPGPZimbraSecure.getInstance = function() {
    return appCtxt.getZimletMgr().getZimletByName('openpgp_zimbra_secure').handlerObject;
};

OpenPGPZimbraSecure.prototype.getPGPKeys = function() {
    return this._pgpKeys;
};

OpenPGPZimbraSecure.prototype.getSecurePassword = function() {
    return this._securePassword;
};

/**
 * Additional processing of message from server before handling control back
 * to Zimbra.
 *
 * @param {AjxCallback} callback original callback
 * @param {ZmCsfeResult} csfeResult
 */
OpenPGPZimbraSecure.prototype._handleMessageResponse = function(callback, csfeResult) {
    var self = this;
    var encoded = false;
    if (csfeResult) {
        var response = csfeResult.getResponse();
    }
    else {
        response = { _jsns: 'urn:zimbraMail', more: false };
    }

    function hasPGPPart(part) {
        var cType = part.ct;

        if (OpenPGPUtils.isOPENPGPContentType(cType)) {
            return true;
        } else if (!part.mp) {
            return false;
        }
        if (cType != ZmMimeTable.MSG_RFC822) {
            //do not look at subparts in attached message
            for (var i = 0; i < part.mp.length; i++) {
                if (hasPGPPart(part.mp[i]))
                    return true;
            }
        }

        return false;
    }

    var pgpMsgs = [];
    var msgs = [];

    for (var name in response) {
        var m = response[name].m;
        if (!m && response[name].c) {
            m = response[name].c[0].m;
        }
        if (m) {
            for (var i = 0; i < m.length; i++) {
                if (m[i]) {
                    msgs.push(m[i]);
                }
            }
        }
    }

    msgs.forEach(function(msg) {
        if (hasPGPPart(msg)) {
            pgpMsgs.push(msg);
        }
    });

    if (pgpMsgs.length == 0) {
        callback.run(csfeResult);
    } else {
        this._loadMessages(callback, csfeResult, pgpMsgs);
    }
};

/**
 * Load and decrypt the given pgp messages.
 * @param {AjxCallback} callback
 * @param {?} csfeResult
 * @param {Array} pgpMsgs messages to load.
 */
OpenPGPZimbraSecure.prototype._loadMessages = function(callback, csfeResult, pgpMsgs){
    var self = this;
    var handled = 0;
    var allLoadedCheck = new AjxCallback(function(){
        handled += 1;

        if (handled == pgpMsgs.length) {
            callback.run(csfeResult);
        }
    });

    pgpMsgs.forEach(function(msg) {
        var newCallback = new AjxCallback(self, self._decryptMessage, [allLoadedCheck, msg]);
        var partId = msg.part ? '&part=' + msg.part : '';
        //add a timestamp param so that browser will not cache the request
        var timestamp = '&timestamp=' + new Date().getTime();

        var loadUrl = [
            appCtxt.get(ZmSetting.CSFE_MSG_FETCHER_URI), '&id=', msg.id, partId, timestamp
        ].join('');

        AjxRpc.invoke('', loadUrl, {
            'X-Zimbra-Encoding': 'x-base64'
        }, newCallback, true);
    });
};

/**
 * PGP Mime decrypt the given text.
 * @param {AjxCallback} callback
 * @param {ZmMailMsg} msg
 * @param {Object} response
 */
OpenPGPZimbraSecure.prototype._decryptMessage = function(callback, msg, response){
    var self = this;
    if (response.success) {
        var decryptor = new OpenPGPDecrypt({
            privateKey: this._pgpKeys.getPrivateKey(),
            publicKeys: this._pgpKeys.getPublicKeys(),
            onDecrypted: function(decryptor, message) {
                self.onDecrypted(callback, msg, message);
            },
            onError: function(decryptor, error) {
                console.log(error);
                self._onEncryptError('decrypting-error');
            }
        }, OpenPGPUtils.base64Decode(response.text));
        decryptor.decrypt();
    } else {
        console.warn('Failed to get message source:');
        console.warn(response);
        callback.run();
    }
};

/**
 * Process the decrypted message before parsing control back to Zimbra.
 * @param {AjxCallback} callback
 * @param {ZmMailMsg} msg
 * @param {Object} PGP mime message.
 */
OpenPGPZimbraSecure.prototype.onDecrypted = function(callback, msg, pgpMessage) {
    this._pgpMessageCache[msg.id] = pgpMessage;

    if (pgpMessage.encrypted) {
        var mp = OpenPGPUtils.mimeMessageToZmMimePart(pgpMessage);
        msg.mp = [];
        msg.mp.push(mp);
    }

    callback.run();
};

/**
* Sends the given message
* @param {Function} orig original func ZmMailMsg.prototype._sendMessage
* @param {ZmMailMsg} msg
* @param {Object} params the mail params inluding the jsonObj msg.
*/
OpenPGPZimbraSecure.prototype._sendMessage = function(orig, msg, params) {
    var self = this;
    var shouldSign = false, shouldEncrypt = false;
    var isDraft = false;

    if (params.jsonObj.SendMsgRequest || params.jsonObj.SaveDraftRequest) {
        // Get preference setting, and use it if the toolbar does not override it.
        shouldSign = this._shouldSign();
        shouldEncrypt = this._shouldEncrypt();

        var view = appCtxt.getCurrentView();
    }

    if (params.jsonObj.SaveDraftRequest) {
        isDraft = true;
        shouldSign = false;
        shouldEncrypt = false;
    }

    if (!this._pgpKeys.getPrivateKey()) {
        shouldSign = false;
    }

    if (this._pgpKeys.getPublicKeys().length === 0) {
        shouldEncrypt = false;
    }

    if (!shouldSign && !shouldEncrypt) {
        // call the wrapped function
        orig.apply(msg, [params]);
        return;
    }

    var input = (params.jsonObj.SendMsgRequest || params.jsonObj.SaveDraftRequest);
    var hasFrom = false;

    for (var i = 0; !hasFrom && i < input.m.e.length; i++) {
        if (input.m.e[i].t == 'f') {
            hasFrom = true;
        }
    }

    if (!hasFrom) {
        var addr = OpenPGPUtils.getDefaultSenderAddress();
        input.m.e.push({ 'a': addr.toString(), 't': 'f' });
    }

    function checkAttachments(list, cid, fmt) {
        for (var i = 0; list && i < list.length; i++) {
            var url = appCtxt.get(ZmSetting.CSFE_MSG_FETCHER_URI);
            if (fmt) {
                url += '&fmt=native';
            }
            var part = OpenPGPUtils.fetchPart(list[i], url);
            if (part) {
                if (cid) {
                    part.ci = '<' + cid + '>';
                    if (/^image\//.test(part.ct)) {
                        //for images replace the src url of cid with the data uri
                        var oldSrc = 'cid:' + cid;
                        //get the content type upto ; character
                        var ctIndex = part.ct.indexOf(';');
                        if (ctIndex == -1) ctIndex = part.ct.length;
                        var newSrc = 'data:' + part.ct.substring(0, ctIndex) + ';base64,' + part.data;
                        view._htmlEditor.replaceImageSrc(oldSrc, newSrc);
                    }
                }
                self._pendingAttachments.push(part);
            }
        }
    };

    function checkInlineAttachments(multiPart) {
        for(var i = multiPart.length - 1; i >= 0 ; i--) {
            var subPart = multiPart[i];
            if (subPart.attach) {
                checkAttachments(subPart.attach.mp, subPart.ci);
                checkAttachments(subPart.attach.doc, subPart.ci);
                multiPart.splice(i, 1);
            } else if (subPart.mp) {
                checkInlineAttachments(subPart.mp);
            }
        }
    };

    if (input.m.attach) {
        checkAttachments(input.m.attach.mp);
        checkAttachments(input.m.attach.m);
        checkAttachments(input.m.attach.cn);
        checkAttachments(input.m.attach.doc, null, 'native');
        delete input.m.attach;
    }
    checkInlineAttachments(input.m.mp);

    var contentParts = [];
    input.m.mp.forEach(function(part) {
        if (part.mp) {
            part.mp.forEach(function(mp) {
                contentParts.push(mp);
            });
        }
        else {
            contentParts.push(part);
        }
    });

    var attachments = [];
    while (this._pendingAttachments.length > 0) {
        attachments.push(this._pendingAttachments.pop());
    }

    var receivers = [];
    input.m.e.forEach(function(e) {
        if (e.t == 't') {
            receivers.push(e.a);
        }
        if (e.t == 'c') {
            receivers.push(e.a);
        }
        if (e.t == 'b') {
            receivers.push(e.a);
        }
    });

    var encryptor = new OpenPGPEncrypt({
        privateKey: this._pgpKeys.getPrivateKey(),
        publicKeys: this._pgpKeys.filterPublicKeys(receivers),
        shouldEncrypt: shouldEncrypt,
        onEncrypted: function(signer, builder) {
            builder.importHeaders(input.m);
            self._onEncrypted(params, input, orig, msg, builder.toString());
        },
        onError: function(signer, error) {
            console.log(error);
            self._onEncryptError('encrypting-error');
        }
    }, new OpenPGPMimeBuilder({
        contentParts: contentParts,
        attachments: attachments
    }));
    encryptor.encrypt();
};

OpenPGPZimbraSecure.prototype._onEncrypted = function(params, input, orig, msg, message) {
    var url = appCtxt.get(ZmSetting.CSFE_ATTACHMENT_UPLOAD_URI) + '?fmt=raw';

    var callback = new AjxCallback(this, function(response) {
        var values = null;
        if (response.success) {
            var values = JSON.parse('[' + response.text.replace(/'/g, '"')  + ']');
        }
        if (values && values.length == 3 && values[0] == 200) {
            var uploadId = values[2];
            var origCallback = params.callback;
            var origMsg = input.m;

            params.callback = new AjxCallback(this, function(response) {
                try {
                    origCallback.run(response);
                } catch (e) {
                    console.error(e);
                    throw e;
                }
            });

            input.m = { aid: uploadId };

            for (var k in origMsg) {
                if (k != 'mp') {
                    input.m[k] = origMsg[k];
                }
            }

            orig.apply(msg, [params]);
        }
        else {
            this._onEncryptError('encrypting-error');
        }
    });

    AjxRpc.invoke(message, url, {
        'Content-Type': ZmMimeTable.MSG_RFC822,
        'Content-Disposition': 'attachment; filename="message.eml"'
    }, callback);
};

OpenPGPZimbraSecure.prototype._onEncryptError = function(error){
    OpenPGPZimbraSecure.popupErrorDialog(error);
};

/**
 * This method is called when a message is viewed in Zimbra.
 * This method is called by the Zimlet framework when a user clicks-on a message in the mail application.
 */
OpenPGPZimbraSecure.prototype.onMsgView = function(msg, oldMsg, msgView) {
    this._renderMessageInfo(msg, msgView);
};

OpenPGPZimbraSecure.prototype.onMsgExpansion = function(msg, msgView) {
    this._renderMessageInfo(msg, msgView);
};

OpenPGPZimbraSecure.prototype.onConvView = function(msg, oldMsg, convView) {
    this._renderMessageInfo(msg, convView);
};

OpenPGPZimbraSecure.prototype._renderMessageInfo = function(msg, view) {
    if (!msg || !view._hdrTableId || msg.isDraft)
        return;
    var pgpMessage = this._pgpMessageCache[msg.id];
    if (!pgpMessage) {
        return;
    }

    var self = this;
    pgpMessage.signatures.forEach(function(signature) {
        var userid = AjxStringUtil.htmlEncode(signature.userid);
        var desc = signature.valid ? AjxMessageFormat.format(openpgp_zimbra_secure.goodSignatureFrom, userid) : AjxMessageFormat.format(openpgp_zimbra_secure.badSignatureFrom, userid);

        var htmls = [];
        htmls.push(AjxMessageFormat.format('<span style="color: {0};">', signature.valid ? 'green' : 'red'));
        htmls.push(AjxMessageFormat.format('<img class="OpenPGPSecureImage" src="{0}" />', self.getResource(signature.valid ? 'imgs/valid.png' : 'imgs/corrupt.png')));
        htmls.push(desc);
        htmls.push('</span>');

        var output = htmls.join('');
        var headerIds = self._msgDivCache[msg.id] = self._msgDivCache[msg.id] || [];
        if (headerIds && headerIds.length) {
            for (var i = 0; i < headerIds.length; i++) {
                var el = Dwt.byId(headerIds[i]);
                if (el) {
                    el.innerHTML = output;
                }
            }
        }

        var id = Dwt.getNextId();
        headerIds.push(id);
        if (Dwt.byId((view._hdrTableId + '-signature-info'))) return;

        var params = {
            info: output,
            id: view._hdrTableId + '-signature-info'
        };
        var html = AjxTemplate.expand('openpgp_zimbra_secure#securityHeader', params);

        var hdrtable = Dwt.byId(view._hdrTableId);
        hdrtable.firstChild.appendChild(Dwt.parseHtmlFragment(html, true));
    });

    if (pgpMessage.encrypted) {
        attLinksId = view._attLinksId;
        var attachments = [];
        OpenPGPUtils.visitMessage(pgpMessage, function(message) {
            var cd = message.header('Content-Disposition');
            if (cd === 'attachment' && typeof message._body === 'string') {
                var content;
                var encode = message.header('Content-Transfer-Encoding');
                if (encode === 'base64') {
                    content = OpenPGPUtils.base64Decode(message._body);
                }
                else if (encode === 'quoted-printable') {
                    content = utf8.decode(quotedPrintable.decode(message._body));
                }
                else {
                    content = message._body;
                }

                var contentType = message.contentType();
                var attachment = {
                    id: OpenPGPUtils.randomString(),
                    type: contentType.fulltype,
                    name: 'attachment',
                    size: content.length,
                    content: message._body,
                    raw: content
                };
                if (contentType.params.name) {
                    attachment.name = contentType.params.name;
                }
                attachments.push(attachment);
                self._pgpAttachments[attachment.id] = attachment;
            }
        });

        var el = document.getElementById(view._attLinksId);
        if (el) {
            return;
        }
        if (attachments.length > 0) {
            var numFormatter = AjxNumberFormat.getInstance();
            var msgBody = Dwt.byId(view._msgBodyDivId);
            var div = document.createElement('div');
            div.id = view._attLinksId;
            div.className = 'attachments';

            var linkId = '';
            var attLinkIds = [];
            var htmlArr = [];
            htmlArr.push('<table id="' + view._attLinksId + '_table" cellspacing="0" cellpadding="0" border="0">');
            attachments.forEach(function(attachment, index) {
                htmlArr.push('<tr><td>');
                htmlArr.push('<table border=0 cellpadding=0 cellspacing=0 style="margin-right:1em; margin-bottom:1px"><tr>');
                htmlArr.push('<td style="width:18px">');

                var mimeInfo = ZmMimeTable.getInfo(attachment.type);
                htmlArr.push(AjxImg.getImageHtml(mimeInfo ? mimeInfo.image : 'GenericDoc', "position:relative;", null, false, false, null, 'attachment'));
                htmlArr.push('</td><td style="white-space:nowrap">');

                var content = attachment.content.replace(/\r?\n/g, '');
                var linkAttrs = [
                    'class="AttLink"',
                    'href="javascript:;//' + attachment.name + '"',
                    'data-id="' + attachment.id + '"'
                ].join(' ');
                htmlArr.push('<span class="Object" role="link">');
                linkId = view._attLinksId + '_' + msg.id + '_' + index + '_name';
                htmlArr.push('<a id="' + linkId + '" ' + linkAttrs + ' title="' + attachment.name + '">' + attachment.name + '</a>');
                attLinkIds.push(linkId);
                htmlArr.push('</span>');

                if (attachment.size < 1024) {
                    size = numFormatter.format(attachment.size) + " " + ZmMsg.b;
                }
                else if (attachment.size < (1024 * 1024)) {
                    size = numFormatter.format(Math.round((attachment.size / 1024) * 10) / 10) + " " + ZmMsg.kb;
                }
                else {
                    size = numFormatter.format(Math.round((attachment.size / (1024 * 1024)) * 10) / 10) + " " + ZmMsg.mb;
                }
                htmlArr.push('&nbsp;(' + size + ')&nbsp;');

                htmlArr.push('|&nbsp;');
                linkId = view._attLinksId + '_' + msg.id + '_' + index + '_download';
                htmlArr.push('<a id="' + linkId + '" ' + linkAttrs + ' style="text-decoration:underline" title="' + ZmMsg.download + '">' + ZmMsg.download + '</a>');
                attLinkIds.push(linkId);

                htmlArr.push('</td></tr></table>');
                htmlArr.push('</td></tr>');
            });
            htmlArr.push('</table>');

            div.innerHTML = htmlArr.join('');
            msgBody.parentNode.insertBefore(div, msgBody);

            attLinkIds.forEach(function(id) {
                var link = document.getElementById(id);
                if (link) {
                    link.onclick = function() {
                        self._download(this);
                    };
                }
            });
        }
    }
};

/**
 * This method gets called by the Zimlet framework when a toolbar is created.
 *
 * @param {ZmApp} app
 * @param {ZmButtonToolBar} toolbar
 * @param {ZmController} controller
 * @param {String} viewId
 */
OpenPGPZimbraSecure.prototype.initializeToolbar = function(app, toolbar, controller, viewId) {
    if (viewId.indexOf('COMPOSE') >= 0) {
        var button;
        var children = toolbar.getChildren();
        for (var i = 0; i < children.length && !button; i++) {
            if (Dwt.hasClass(children[i].getHtmlElement(), OpenPGPZimbraSecure.BUTTON_CLASS)) {
                button = children[i];
                break;
            }
        }
        var selectedValue;
        var enableSecurityButton = true;
        var msg = controller.getMsg();
        if (msg && msg.isInvite()) {
            selectedValue = OpenPGPZimbraSecure.OPENPGP_DONTSIGN;
            enableSecurityButton = false;
        } else if (msg && msg.isDraft) {
            selectedValue = OpenPGPZimbraSecure.OPENPGP_DONTSIGN;
        } else {
            selectedValue = this._getSecuritySetting();
        }
        if (!button) {
            var index = AjxUtil.indexOf(toolbar.opList, ZmOperation.COMPOSE_OPTIONS) + 1;
            var id = Dwt.getNextId() + '_' + OpenPGPZimbraSecure.BUTTON_CLASS;
            
            var securityButton = new DwtToolBarButton({
                parent: toolbar,
                id: id + '_checkbox',
                index: index,
                className: OpenPGPZimbraSecure.BUTTON_CLASS + ' ZToolbarButton'
            });

            var securityMenu = new DwtMenu({
                parent: securityButton,
                id: id + '_menu'
            });
            var signingRadioId = id + '_menu_sign';

            securityButton.setMenu(securityMenu);

            var listener = new AjxListener(this, this._handleSelectSigning, [securityButton]);

            var nosignButton = new DwtMenuItem({parent: securityMenu, style: DwtMenuItem.RADIO_STYLE, radioGroupId: signingRadioId});
            nosignButton.setText(OpenPGPUtils.prop('dontSignMessage'));
            nosignButton.addSelectionListener(listener);
            nosignButton.setData('sign', OpenPGPZimbraSecure.OPENPGP_DONTSIGN);

            var signButton = new DwtMenuItem({parent: securityMenu, style: DwtMenuItem.RADIO_STYLE, radioGroupId: signingRadioId});
            signButton.setText(OpenPGPUtils.prop('signMessage'));
            signButton.addSelectionListener(listener);
            signButton.setData('sign', OpenPGPZimbraSecure.OPENPGP_SIGN);

            var signAndEncryptButton = new DwtMenuItem({parent: securityMenu, style: DwtMenuItem.RADIO_STYLE, radioGroupId: signingRadioId});
            signAndEncryptButton.setText(OpenPGPUtils.prop('signAndEncryptMessage'));
            signAndEncryptButton.addSelectionListener(listener);
            signAndEncryptButton.setData('sign', OpenPGPZimbraSecure.OPENPGP_SIGNENCRYPT);

            securityMenu.checkItem('sign', selectedValue, true);
            this._setSecurityImage(securityButton, selectedValue);
            securityButton.setEnabled(enableSecurityButton);
        } else {
            var menu = button.getMenu();
            if (menu) {
                menu.checkItem('sign', selectedValue, true);
                this._setSecurityImage(button, selectedValue);
            }
            button.setEnabled(enableSecurityButton);
        }
    }
};

OpenPGPZimbraSecure.prototype._setSecurityImage = function(button, value) {
    button.setImage(OPENPGP_SECURITY_TYPES[value].className);
    button.setText(OPENPGP_SECURITY_TYPES[value].label);
};

/*
 * Event handler for select signing button on toolbar
 */
OpenPGPZimbraSecure.prototype._handleSelectSigning = function(button, ev) {
    var value = ev.dwtObj.getData('sign');

    this._setSecurityImage(button, value);

    var view = appCtxt.getCurrentView();
    var composeCtrl = view && view.getController && view.getController();

    // hide upload button form to suppress HTML5 file upload dialogs
    OpenPGPZimbraSecure._fixFormVisibility(view._attButton.getHtmlElement(), value == OpenPGPZimbraSecure.OPENPGP_DONTSIGN);

    this.setUserProperty(OpenPGPZimbraSecure.USER_SECURITY, value);
    this.saveUserProperties();
    composeCtrl.saveDraft(ZmComposeController.DRAFT_TYPE_AUTO);
};

OpenPGPZimbraSecure._fixFormVisibility = function(element, visible) {
    if (AjxEnv.supportsHTML5File) {
        var forms = element.getElementsByTagName('form');

        for (var i = 0; i < forms.length; i++)
            Dwt.setVisible(forms.item(i), visible);
    }
};

OpenPGPZimbraSecure.prototype._getSecurityButtonFromToolbar = function(toolbar) {
    var children = toolbar.getChildren();
    for (var i = 0; i < children.length; i++) {
        if (Dwt.hasClass(children[i].getHtmlElement(), OpenPGPZimbraSecure.BUTTON_CLASS)) {
            return children[i];
        }
    }
};

OpenPGPZimbraSecure.prototype._getUserSecuritySetting = function(ctlr, useToolbarOnly) {
    var app = appCtxt.getApp('Mail');
    AjxDispatcher.require(['MailCore','Mail']);
    var view = appCtxt.getAppViewMgr().getCurrentView();
    ctlr = ctlr || (view && view.isZmComposeView && view.getController());
    if (!useToolbarOnly) {
        ctlr = ctlr || app.getComposeController(app.getCurrentSessionId('COMPOSE'));
    }
    var toolbar = ctlr && ctlr._toolbar;
    var button = toolbar && this._getSecurityButtonFromToolbar(toolbar);
    var menu = button && button.getMenu();

    if (menu) {
        return menu.getSelectedItem().getData('sign');
    } else if (useToolbarOnly) {
        //only local setting is requested.
        return false;
    } else {
        return this._getSecuritySetting();
    }
};

OpenPGPZimbraSecure.prototype._getSecuritySetting = function() {
    if (appCtxt.isChildWindow) {
        return window.opener.appCtxt.getZimletMgr().getZimletByName('openpgp_zimbra_secure').handlerObject._getUserSecuritySetting();
    } else {
        var setting = appCtxt.get(OpenPGPZimbraSecure.PREF_SECURITY);
        if (setting == 'auto') {
            return Number(this.getUserProperty(OpenPGPZimbraSecure.USER_SECURITY) || 0);
        } else {
            return Number(setting);
        }
    }
};

OpenPGPZimbraSecure.prototype._shouldSign = function(ctlr, useToolbarOnly) {
    var value = this._getUserSecuritySetting(ctlr, useToolbarOnly);
    return (value == OpenPGPZimbraSecure.OPENPGP_SIGN || value == OpenPGPZimbraSecure.OPENPGP_SIGNENCRYPT);
};

OpenPGPZimbraSecure.prototype._shouldEncrypt = function(ctlr, useToolbarOnly) {
    return this._getUserSecuritySetting(ctlr, useToolbarOnly) == OpenPGPZimbraSecure.OPENPGP_SIGNENCRYPT;
};

OpenPGPZimbraSecure.prototype._addJsScripts = function(paths, callback) {
    var self = this;
    var head = document.getElementsByTagName('head')[0];

    function loadNextScript(script) {
        if (AjxEnv.isIE && script && !/loaded|complete/.test(script.readyState))
            return;
        window.status = '';
        if (paths.length > 0) {
            var path = paths.shift();
            var script = document.createElement('script');
            var handler = AjxCallback.simpleClosure(loadNextScript, null, script);
            if (script.attachEvent) {
                script.attachEvent('onreadystatechange', handler);
                script.attachEvent('onerror', handler);
            }
            else if (script.addEventListener) {
                script.addEventListener('load', handler, true);
                script.addEventListener('error', handler, true);
            }
            script.type = 'text/javascript';
            script.src = self.getResource(path);
            window.status = 'Loading script: ' + path;
            head.appendChild(script);
        }
        else if (paths.length == 0) {
            script = null;
            head = null;
            if (callback) {
                callback.run();
            }
        }
    }
    loadNextScript(null);
};

OpenPGPZimbraSecure.prototype._initOpenPGP = function() {
    var self = this;
    var sequence = Promise.resolve();
    sequence.then(function() {
        var path = self.getResource('js/openpgpjs/openpgp.worker.min.js');
        openpgp.initWorker({
            path: path
        });
        return self._pgpKeys.init();
    })
    .then(function() {
        OpenPGPSecurePrefs.init(self);
    });
};

OpenPGPZimbraSecure.prototype._download = function(element) {
    var id = element.getAttribute('data-id');
    if (this._pgpAttachments[id]) {
        var attachment = this._pgpAttachments[id];
        OpenPGPUtils.saveAs(attachment.content, attachment.name, attachment.type);
    }
}

OpenPGPZimbraSecure.popupErrorDialog = function(errorCode){
    if(!errorCode){
        errorCode = 'unknown-error';
    }
    var msg = OpenPGPUtils.prop(errorCode);
    var title = OpenPGPUtils.prop(errorCode + '-title');

    var dialog = appCtxt.getHelpMsgDialog();
    dialog.setMessage(msg, DwtMessageDialog.CRITICAL_STYLE, title);
    dialog.setHelpURL(appCtxt.get(ZmSetting.SMIME_HELP_URI));
    dialog.popup();
};

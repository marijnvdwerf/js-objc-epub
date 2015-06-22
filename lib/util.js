var url = require('url');

var Util = {
    getSlugfromUri: function(issueUri) {
        var components = url.parse(issueUri).pathname.split('/');

        for (var i = components.length - 1; i >= 0; i--) {
            if (components[i].trim() !== '') {
                return components[i];
            }
        }

        return null;
    },

    getMimeType: function(filename) {
        var ext = filename.split('.').pop().toLowerCase();

        switch (ext) {
            case 'png':
                return 'image/png';

            case 'gif':
                return 'image/gif';

            case 'jpg':
            case 'jpeg':
                return 'image/jpeg';

            case 'css':
                return 'text/css';

            case 'otf':
                return 'application/font-sfnt';

            case 'ttf':
                return 'application/x-font-ttf';

            case 'html':
                return 'application/xhtml+xml';

            default:
                return false;
        }
    },

    resolveUriAttribute: function($, baseUri, attributeName) {
        return function() {
            var $el = $(this);

            if ($el.attr(attributeName) === undefined) {
                return null;
            }

            if ($el.attr(attributeName)[0] === '#') {
                // Ignore local links
                return;
            }

            var fullUri = url.resolve(baseUri, $el.attr(attributeName));
            $el.attr(attributeName, fullUri);
        }
    },

    remapAssets: function($, $content, uriMapping) {
        $content.find('a').each(function() {
            var $el = $(this);
            $el.attr('href', uriMapping[$el.attr('href')]);
        });

        $content.find('img').each(function() {
            var $el = $(this);
            $el.attr('src', uriMapping[$el.attr('src')]);
        });
    }
};

module.exports = Util;



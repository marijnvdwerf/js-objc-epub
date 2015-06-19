var request = require('request');
var cheerio = require('cheerio');
var fs = require('fs');
var url = require('url');
var _ = require('underscore');
var jade = require('jade');
var highlight = require('highlight.js');
var ncp = require('ncp').ncp;
var archiver = require('archiver');


var overviewUrl = 'http://www.objc.io/issues/';

function main(issueToGet) {
    request({
        uri: overviewUrl,
        gzip: true
    }, function(error, response, body) {
        if (error) {
            console.error(error);
            return;
        }

        var $ = cheerio.load(body);
        var issueURI = $('.c-issue-unit[id="' + issueToGet + '"]').find('a').first().attr('href');

        downloadIssue(url.resolve(overviewUrl, issueURI));
    });
}

function getSlugfromUri(issueUri) {
    var components = url.parse(issueUri).pathname.split('/');

    for (var i = components.length - 1; i >= 0; i--) {
        if (components[i].trim() !== '') {
            return components[i];
        }
    }

    return null;
}

function getMimeType(filename) {
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

        default:
            return false;
    }
}

function downloadIssue(issueUri) {

    request({
        uri: issueUri,
        gzip: true
    }, function(error, response, body) {
        if (error) {
            console.error(error);
            return;
        }

        var $ = cheerio.load(body);

        var issue = {
            number: $('.c-issue__header__number').text().trim(),
            name: $('.c-issue__header__name').text().trim(),
            date: $('.c-issue__header__date').text().trim(),
            coverUri: url.resolve(issueUri, $('.c-issue__cover img').attr('src')),
            articles: []
        };

        $('.c-issue__article').each(function(i, el) {
            var article = {
                title: $(el).find('.c-issue__article__name').text().trim(),
                uri: url.resolve(issueUri, $(el).find('a').first().attr('href'))
            };


            article.id = 'ch' + i + '-' + getSlugfromUri(article.uri);

            issue.articles.push(article);
        });


        var tempDir = __dirname + '/tmp';

        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }

        var slug = getSlugfromUri(issueUri);
        var epubDir = tempDir + '/' + slug + '.epub';
        var contentDir = epubDir + '/OEBPS/';

        var epub = {
            title: issue.name,
            manifest: [],
            spine: [],
            addItem: function(id, properties) {
                if (properties === undefined || properties === null) {
                    properties = false;
                }
                this.spine.push({id: id, properties: properties});
            },
            addFile: function(filename) {
                var id = 'file-' + (this.manifest.length);

                this.manifest.push({
                    id: id,
                    href: filename,
                    mediaType: getMimeType(filename)
                });
            }
        };

        ncp(__dirname + '/skeleton', epubDir, function(err) {
            if (err) {
                console.error(err);
            }

            request(issue.coverUri).pipe(fs.createWriteStream(contentDir + '/images/cover.jpg'));
            epub.manifest.push({
                id: 'cover',
                href: 'images/cover.jpg',
                mediaType: 'image/jpeg',
                properties: 'cover-image'
            });
        });


        var contentTemplate = jade.compileFile(__dirname + '/template/content.opf.jade', {pretty: true});
        var articleTemplate = jade.compileFile(__dirname + '/template/article.jade', {pretty: true});

        var saveContent = _.after(issue.articles.length, function() {
            fs.writeFileSync(contentDir + '/content.opf', contentTemplate(epub));
        });

        epub.addFile('fonts/Roboto-Bold.ttf');
        epub.addFile('fonts/RobotoMono-Regular.ttf');
        epub.addFile('styles/main.css');
        epub.manifest.push({
            id: 'toc',
            href: '01-toc.html',
            mediaType: 'application/xhtml+xml',
            properties: 'nav'
        });
        epub.manifest.push({
            id: 'cover-page',
            href: '00-cover.html',
            mediaType: 'application/xhtml+xml'
        });

        epub.addItem('cover-page', 'page-spread-right rendition:layout-pre-paginated');
        epub.addItem('toc');
        _.each(issue.articles, function(article) {
            epub.addItem(article.id);
        });

        var imgCount = 0;

        _.each(issue.articles, function(article, chapterNo) {
            request({
                uri: article.uri,
                gzip: true
            }, function(error, response, body) {
                if (error) {
                    console.error(error);
                    return;
                }

                body = body.replace('<hr>', '<hr/>');

                var $ = cheerio.load(body, {xmlMode: true});
                var $text = $('.c-text');

                article.authors = $('.c-article__header__byline a')
                    .map(function(i, anchorEl) {
                        var $anchor = $(anchorEl);
                        return {
                            name: $anchor.text(),
                            uri: url.resolve(article.uri, $anchor.attr('href'))
                        };
                    })
                    .get();

                $text.find('img').each(function() {
                    var imgEl = $(this);
                    var imageUri = url.resolve(article.uri, imgEl.attr('src'));
                    var filename = getSlugfromUri(imageUri);
                    request(imageUri).pipe(fs.createWriteStream(contentDir + '/images/' + filename));
                    imgEl.attr('src', 'images/' + filename);

                    epub.manifest.push({
                        id: 'img-' + (imgCount++),
                        href: 'images/' + filename,
                        mediaType: getMimeType(filename)
                    });
                });

                $text.find('a[rev]').attr('rev', null);

                $text.find('pre > code').each(function() {
                    var codeEl = $(this);
                    var lang = codeEl.attr('class');

                    if (lang === undefined) {
                        return;
                    }

                    var hl = highlight.highlight(lang, codeEl.text());

                    codeEl.empty().append(hl.value).addClass('hljs');
                });

                $text.find('a').each(function() {
                    var anchorEl = $(this);

                    if (anchorEl.attr('href') === undefined) {
                        return null;
                    }

                    if (anchorEl.attr('href')[0] === '#') {
                        // Ignore local links
                        return;
                    }

                    var fullUri = url.resolve(article.uri, anchorEl.attr('href'));
                    anchorEl.attr('href', fullUri);
                });

                article.text = $text.html();
                var slug = getSlugfromUri(article.uri);

                var filename = (10 + chapterNo) + '-' + slug + '.html';

                fs.writeFileSync(contentDir + '/' + filename, articleTemplate({article: article}));
                epub.manifest.push({
                    id: article.id,
                    href: filename,
                    mediaType: 'application/xhtml+xml'
                });
                saveContent();
            });
        });

    });
}

function saveAsEpub(baseDir, fileName) {
    var epub = archiver.create('zip');

    epub
        .file(baseDir + '/mimetype', {name: 'mimetype', store: true})
        .bulk([
            {expand: true, cwd: baseDir, src: ['META-INF/**', 'OEBPS/**']}
        ])
        .finalize()
        .pipe(fs.createWriteStream(fileName));
}


//main(23);
//downloadIssue('http://www.objc.io/issues/11-android/');


saveAsEpub(__dirname + '/tmp/11-android.epub', __dirname + '/11-android.epub');
